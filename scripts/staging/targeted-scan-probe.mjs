#!/usr/bin/env node
// Targeted, sequential PEN / JHB scan-path diagnosis against the tagged targeted fixtures (staging only). NOT a UAT run.
//   node --env-file=.env.local --experimental-strip-types --experimental-loader ./tests/loader.mts scripts/staging/targeted-scan-probe.mjs \
//        --url=<preview> --run-id=<targeted run id> [--browser=0]
// Prints sanitized evidence only: method, host/path (no query), status, timings, result codes. No credentials, tokens, e-mails, bodies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest } from "./lib/review-accounts.mjs";
import { assignmentsFromRpcRows, deriveCanonicalAccess, deriveOperatorScope } from "../../lib/auth/canonical-access.ts";
import { decideCheckpointAccess, hubDestinationError } from "../../lib/icms/canonical.ts";
import { nextStepFor } from "../../lib/icms/workflow.ts";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
if (!base || !runId) throw new Error("--url and --run-id are required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) throw new Error("production reference present");
const ledger = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-uat-fixtures", `${runId}.json`), "utf8"));
const manifest = loadCurrentManifest();
const creds = loadCurrentCredentials();
const CASES = [
  { label: "aso", station: "PEN", own: "ICMS-2026-990001", other: "ICMS-2026-990002" },
  { label: "aso-jhb", station: "JHB", own: "ICMS-2026-990002", other: "ICMS-2026-990001" },
];
let fails = 0;
const ok = (label, cond, note = "") => { if (!cond) fails += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ database-level path (as the user, under RLS)
const { client } = await connectVerified();
async function asUser(uid, fn) {
  await client.query("BEGIN");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    return await fn();
  } finally { await client.query("ROLLBACK"); }
}
const q = async (s, p) => (await client.query(s, p)).rows;
console.log("=== database path (RPCs / RLS as the officer) ===");
for (const c of CASES) {
  const uid = manifest.find((a) => a.label === c.label).authUserId;
  await asUser(uid, async () => {
    const rows = await q("select * from public.get_my_active_role_assignments()");
    const access = deriveCanonicalAccess(assignmentsFromRpcRows(rows));
    const scope = deriveOperatorScope(access);
    ok(`${c.label}: one active station assignment at ${c.station}`, scope.station === c.station && !scope.orgWide, `station=${scope.station} roles=${scope.roleCodes.join(",")}`);
    const cap = (await q("select public.can_user_scan_caterlink($1) v", [c.station]))[0].v;
    ok(`${c.label}: can_user_scan_caterlink(${c.station}) = true`, cap === true);
    const decision = decideCheckpointAccess(access, cap === true);
    ok(`${c.label}: checkpoint access decision allows`, decision.allowed === true, JSON.stringify(decision));
    const duty = (await q("select count(*)::int n from public.duty_records where profile_id = $1 and duty_date = (now() at time zone 'Asia/Kuala_Lumpur')::date and check_in_at is not null and check_out_at is null", [uid]))[0].n;
    ok(`${c.label}: exactly ONE open duty row today (the app uses .maybeSingle(); two rows would read as not-on-duty)`, duty === 1, `rows=${duty}`);
    const own = await q("select id, status, direction, route, hub_destination from public.transactions where transaction_number = $1", [c.own]);
    ok(`${c.label}: secure lookup of its own station's movement finds exactly one`, own.length === 1, `rows=${own.length}`);
    if (own[0]) {
      const step = nextStepFor(own[0].direction, own[0].status, own[0].route);
      ok(`${c.label}: workflow selects the next checkpoint (${step?.slug ?? "none"})`, !!step && step.slug === "part-b" || !!step, JSON.stringify({ status: own[0].status, route: own[0].route, step: step?.slug }));
      ok(`${c.label}: no hub-destination refusal for this movement`, hubDestinationError({ nextStepPart: step?.part, route: own[0].route, hubDestination: own[0].hub_destination, userStation: scope.station }) === null);
    }
    const other = await q("select 1 from public.transactions where transaction_number = $1", [c.other]);
    ok(`${c.label}: the OTHER station's movement is invisible (cross-station denied by RLS)`, other.length === 0, `rows=${other.length}`);
  });
}
await client.end();

// ------------------------------------------------------------------ browser path
if (argVal("browser") === "0") { console.log(fails ? `\nDATABASE PATH: ${fails} FAILED` : "\nDATABASE PATH PASSED"); process.exit(fails ? 1 : 0); }
console.log("\n=== browser path ===");
const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
for (const c of CASES) {
  const a = creds.find((x) => x.label === c.label);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  const page = await ctx.newPage();
  const posts = [];
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (r.request().method() === "POST" && u.hostname.endsWith("vercel.app")) {
      const h = r.headers();
      posts.push({ path: u.pathname, status: r.status(), ct: (h["content-type"] ?? "").split(";")[0], redirectHdr: Boolean(h["x-action-redirect"]), at: Date.now() });
    }
  });
  const failed = [];
  page.on("requestfailed", (req) => { const u = new URL(req.url()); failed.push(`${req.method()} ${u.hostname}${u.pathname.slice(0, 80)} ${req.failure()?.errorText}`); });
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[name="email"]', { timeout: 60000 });
  await page.fill('input[name="email"]', a.email);
  await page.fill('input[name="password"]', a.password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 45000 }).catch(() => {});
  ok(`${c.label}: signs in (on duty: not held at the duty gate)`, !/\/(login|avsec\/duty)$/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
  await page.goto(`${base}/avsec/scan`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#unified-scan-manual", { timeout: 30000 });
  // the manual form is only interactive once React has hydrated it; a click before that is a native form submit that discards the input
  await page.waitForFunction(() => { const el = document.querySelector("#unified-scan-manual"); return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$")); }, null, { timeout: 30000 });
  ok(`${c.label}: scanner page opens`, new URL(page.url()).pathname === "/avsec/scan");
  const submit = async (ref, wait) => {
    posts.length = 0;
    const t0 = Date.now();
    await page.fill("#unified-scan-manual", ref);
    await page.getByRole("button", { name: "Find" }).click();
    const nav = await page.waitForURL(/\/icms\/transactions\//, { timeout: wait }).then(() => true).catch(() => false);
    const text = (await page.textContent("body")) ?? "";
    const msg = (text.match(/(Not a recogni[^.]*|Transaction not found[^.]*|You must be checked[^.]*|scanning is disabled[^.]*|Could not read[^.]*|Validation failed[^.]*)/) ?? ["(none)"])[0];
    return { nav, ms: Date.now() - t0, msg, p: new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, ":id"), posts: posts.map((x) => `${x.status} ${x.ct}${x.redirectHdr ? " +redirect-hdr" : ""} ${x.path}`) };
  };
  const bad = await submit("not-a-real-reference", 4000);
  ok(`${c.label}: bad reference reaches validation (capability allowed)`, /recognised/.test(bad.msg), `${bad.msg} ${JSON.stringify(bad.posts)}`);
  const cross = await submit(c.other, 8000);
  ok(`${c.label}: the other station's reference is denied`, !cross.nav && /not found/i.test(cross.msg), `${cross.msg} ${JSON.stringify(cross.posts)}`);
  const own = await submit(c.own, 40000);
  console.log(`  own-reference submit: nav=${own.nav} ${own.ms}ms msg=${own.msg} path=${own.p} posts=${JSON.stringify(own.posts)}`);
  ok(`${c.label}: own reference opens the checkpoint route (/icms/transactions/:id/part-b)`, own.nav && /part-b$/.test(own.p), `${own.ms}ms`);
  if (own.nav) {
    const heading = (await page.locator("h1, h2").first().textContent({ timeout: 10000 }).catch(() => ""))?.trim();
    ok(`${c.label}: the checkpoint page renders (documented "not activated" state for Part B)`, /Part B checkpoint/.test(heading ?? ""), heading);
  }
  if (failed.length) console.log(`  requestfailed (sanitized): ${failed.slice(0, 6).join(" | ")}`);
  await ctx.close();
  await sleep(10000);
}

// ------------------------------------------------------------------ SAT ASO duty-gate check (its own tagged run id, created mid-probe)
if (argVal("sat-run-id")) {
  const satRun = argVal("sat-run-id");
  console.log(String.fromCharCode(10) + "=== SAT ASO duty gate ===");
  const a = creds.find((x) => x.label === "sat_aso");
  const route = async (page, r) => { await page.goto(`${base}${r}`, { waitUntil: "domcontentloaded" }); await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); return new URL(page.url()).pathname; };
  const signIn = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[name="email"]', { state: "visible", timeout: 60000 });
    await page.waitForSelector('input[name="password"]', { state: "visible", timeout: 60000 });
    await page.fill('input[name="email"]', a.email);
    await page.fill('input[name="password"]', a.password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login$/.test(u.pathname), { timeout: 45000 }).catch(() => {});
    return { ctx, page };
  };
  let { ctx, page } = await signIn();
  ok("sat_aso: authenticates", !/\/login$/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
  for (const r of ["/avsec/sat/reports", "/avsec/reports/lookup", "/avsec/bay-board"]) ok(`sat_aso: before duty, ${r} redirects to the duty gate`, (await route(page, r)) === "/avsec/duty");
  await ctx.close();
  const cp = (await import("node:child_process")).spawnSync(process.execPath, ["--env-file=.env.local", "scripts/staging/uat-fixtures.mjs", "--action=create-duty", `--run-id=${satRun}`, "--labels=sat_aso", "--max-run-minutes=60", "--margin-minutes=30", "--live"], { encoding: "utf8" });
  ok("sat_aso: one tagged duty row created and verified active", cp.status === 0, (cp.stdout || "").split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0]?.slice(0, 120));
  await sleep(8000);
  ({ ctx, page } = await signIn());
  ok("sat_aso: on duty, the SAT workspace opens", (await route(page, "/avsec/sat/reports")) === "/avsec/sat/reports");
  const h = (await page.locator("h1, h2").first().textContent({ timeout: 8000 }).catch(() => ""))?.trim();
  ok("sat_aso: the SAT workspace has its heading", !!h, h?.slice(0, 50));
  for (const r of ["/avsec/admin/users", "/super-admin", "/avsec/entity-reports", "/icms/admin/final-pdfs", "/avsec/dashboard", "/avsec/profiling/workspace", "/avsec/investigation/cases", "/avsec/scan"]) {
    ok(`sat_aso: active duty grants no access to ${r}`, (await route(page, r)) !== r);
  }
  await ctx.close();
}
await browser.close();
console.log(fails ? `\nTARGETED PROBE: ${fails} FAILED` : "\nTARGETED PROBE PASSED");
process.exit(fails ? 1 : 0);
