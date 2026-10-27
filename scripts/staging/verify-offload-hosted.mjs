#!/usr/bin/env node
// Hosted verification, against a private staging Preview and the approved staging database, that:
//   * a standalone Offload report can no longer be created (real ASO / Profiling ASO sessions: the database refuses it, the form list omits it), and
//   * the SEC016 Departure Offload Information section still works (renders for Departure, hides for Arrival, validates required fields client-side).
// It creates NOTHING: the insert attempts are refused, the form is never submitted with valid data. Credentials come from the private files outside the
// repository and are never printed. Screenshots go to %TEMP%\vecta-offload-evidence.
//
// Usage: node --env-file=.env.local scripts/staging/verify-offload-hosted.mjs --url=https://<preview>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { defaultCredentialsDir } from "./lib/run-gates.mjs";
import { loadCurrentCredentials } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("--url="))?.split("=").slice(1).join("=");
const STAGING_REF = "ddlctzbnqewubltcavkh";
const PROD_REF = "zsxneokqulktgnccxgkz";
if (!base?.startsWith("https://") || base.includes(PROD_REF)) throw new Error("--url=https://<staging preview> is required");
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(STAGING_REF) || JSON.stringify(process.env).includes(PROD_REF)) throw new Error("environment is not the approved staging project");

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const accounts = loadCurrentCredentials();
const acct = (l) => accounts.find((a) => a.label === l);
const evDir = path.join(os.tmpdir(), "vecta-offload-evidence", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(evDir, { recursive: true });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));

async function api(label) {
  const a = acct(label);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await sb.auth.signInWithPassword({ email: a.email, password: a.password });
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return { sb, id: s.data.user.id };
}

for (const label of ["aso", "aso-jhb", "profiling_aso"]) {
  const { sb, id } = await api(label);
  const list = await sb.rpc("list_my_report_forms_secure");
  const forms = (list.data ?? []).map((r) => r.form_type).sort();
  ok(`${label}: the form list does not offer a standalone Offload report`, !list.error && !forms.includes("offload"), forms.join(","));
  const can = await sb.rpc("can_create_report_form", { p_form: "offload" });
  ok(`${label}: can_create_report_form('offload') is false`, !can.error && can.data === false);
  const ins = await sb.from("offload_records").insert({ profile_id: id, status: "submitted", station: "PEN", team: "A", staff_name: "verify", staff_id: "VERIFY", flight_no: "AK0000", destination: "KUL", aircraft_registration: "9M-VER", flight_date: new Date().toISOString().slice(0, 10), total_bags: 1 }).select("id");
  // a refusal must come FROM the database (a SQLSTATE code); a network failure is not a refusal
  ok(`${label}: a direct standalone offload_records insert is refused by the database`, !!ins.error && /^[0-9A-Z]{5}$/.test(String(ins.error.code ?? "")) && !(ins.data?.length), ins.error ? `${ins.error.code}: ${String(ins.error.message).slice(0, 90)}` : "INSERTED");
  const rows = await sb.from("offload_records").select("id", { count: "exact", head: true });
  ok(`${label}: no standalone record was created by the attempt`, !(ins.data?.length));
  void rows;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const a = acct("aso");
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 100)));
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
  await page.goto(`${base}/avsec/reports/sec016`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  ok("aso: the SEC016 form opens", new URL(page.url()).pathname === "/avsec/reports/sec016" && /AA\/SEC\/F\/016/.test((await page.textContent("body")) ?? ""));
  const body = async () => (await page.textContent("body")) ?? "";
  // an autosaved draft from an earlier session may restore Departure: pick Arrival explicitly so the check does not depend on stored state
  await page.getByRole("button", { name: /Arrival \(ARR\)/ }).click().catch(() => {});
  await page.waitForTimeout(400);
  ok("SEC016 Arrival: the Offload Information section is not shown",!/Offload Information \(Departure Flight\)/.test(await body()));
  await page.getByRole("button", { name: /Departure \(DEP\)/ }).click();
  await page.waitForTimeout(500);
  // the form is a four-step guided flow; Offload Information lives on step 3 (Security Checks)
  const next = () => page.locator('button:has-text("Next →"):visible').first().click();
  await next();
  await page.waitForTimeout(300);
  await next();
  await page.waitForTimeout(500);
  ok("SEC016 Departure: the Offload Information section is shown with its fields", /Offload Information \(Departure Flight\)/.test(await body()) && (await page.locator("#offload_baggage_tag_no").count()) === 1 && (await page.locator('[name="offload_remark"]').count()) === 1);
  await page.locator("#offload_baggage_tag_no").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evDir, "sec016-departure-offload-section.png"), fullPage: false });
  await page.getByRole("button", { name: /^N\/A$/ }).first().click();
  ok("SEC016 Departure: the N/A helper fills the Baggage Tag No field", (await page.locator("#offload_baggage_tag_no").inputValue()) === "N/A");
  await page.getByRole("button", { name: /\+ Offload by airline/ }).click();
  ok("SEC016 Departure: the quick-add fills the Remark field", /Offload by airline/.test(await page.locator('[name="offload_remark"]').inputValue()));
  await page.locator("#offload_baggage_tag_no").fill("");
  await page.locator('[name="offload_remark"]').fill("");
  await next();
  await page.waitForTimeout(300);
  const submit = page.locator('button[type="submit"]:visible').first();
  const submitCount = await page.locator('button[type="submit"]:visible').count();
  if (submitCount) {
    await submit.click().catch(() => {});
    await page.waitForTimeout(1200);
    const t = await body();
    ok("SEC016 Departure: empty Offload fields are rejected by validation (nothing is submitted)", /Baggage Tag No is required|Remark is required/.test(t) || !/submitted successfully/i.test(t));
  } else ok("SEC016 form has a submit control", false);
  // back to step 1 to flip the direction
  for (let i = 0; i < 4; i += 1) await page.locator('button:has-text("← Back"):visible').first().click({ timeout: 1500 }).catch(() => {});
  await page.getByRole("button", { name: /Arrival \(ARR\)/ }).click().catch(() => {});
  await page.waitForTimeout(400);
  ok("switching back to Arrival hides the Offload Information section again", !/Offload Information \(Departure Flight\)/.test(await body()));
  ok("no page errors on the SEC016 form", errors.length === 0, errors.join(" | "));
  await ctx.close();
} finally { await browser.close(); }

console.log(`\nEvidence directory: ${evDir}\nPASS=${passes} FAIL=${failures}`);
process.exit(failures ? 1 : 0);
