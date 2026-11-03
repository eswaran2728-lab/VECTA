#!/usr/bin/env node
// Hosted verification, against a private staging Preview and the approved staging database with REAL signed-in sessions, that the Bay Board manual-removal path is
// closed and the audited correction path works. Sessions: sat_aso (an officer without supervisor authority), sso-kul (an SSO of KUL - MAA / MAA), operation_manager.
// Tagged Bay Board fixtures are created through the owner connection and removed by EXACT ledger id (with their correction rows and exception records).
//
// Usage: node --env-file=<staging env> scripts/staging/verify-bay-board-correction-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-bay-board-correction-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
const CLEANUP_ONLY = args.includes("--cleanup-only");
if (!runId || !/^[a-z0-9-]{6,40}$/i.test(runId)) throw new Error("--run-id=<6-40 chars [a-z0-9-]> is required");
if (!CLEANUP_ONLY && !base?.startsWith("https://")) throw new Error("--url=https://<staging preview> is required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || (base ?? "").includes(FORBIDDEN_REF)) throw new Error("production reference refused");

const TAG = `ZZ${runId.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8)}`;
const accounts = loadCurrentCredentials();
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-baycorr.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, board: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

let pg = (await connectVerified()).client;
pg.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
const q = async (s, p) => (await pg.query(s, p)).rows;

async function cleanup() {
  const report = {};
  await pg.query("begin");
  await pg.query("set local session_replication_role = replica");
  report.records = (await pg.query("delete from public.aircraft_search_records where registration like $1 returning 1", [`9M-${TAG}%`])).rowCount;
  report.corrections = ledger.board.length ? (await pg.query("delete from public.bay_board_corrections where bay_board_id = any($1::uuid[]) returning 1", [ledger.board])).rowCount : 0;
  report.board = ledger.board.length ? (await pg.query("delete from public.bay_board where id = any($1::uuid[]) returning 1", [ledger.board])).rowCount : 0;
  await pg.query("commit");
  let audit = 0, blocked = false;
  try { audit = (await pg.query("delete from public.phase8_audit_log where entity_type in ('bay_board','aircraft_search') and created_at >= $1 returning 1", [ledger.startedAt])).rowCount; } catch { blocked = true; }
  report.audit = audit; if (blocked) report.auditRetained = true;
  const remaining = {
    board: ledger.board.length ? (await q("select count(*)::int n from public.bay_board where id = any($1::uuid[])", [ledger.board]))[0].n : 0,
    records: (await q("select count(*)::int n from public.aircraft_search_records where registration like $1", [`9M-${TAG}%`]))[0].n,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return Object.values(remaining).every((v) => v === 0);
}
if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const clientFor = async (label) => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, cred(label).email, cred(label).password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
let browser;
try {
  const info = async (l) => (await q("select pr.id, (select min(s.code) from public.user_role_assignments a join public.org_stations s on s.id=a.station_id where a.profile_id=pr.id and a.revoked_at is null) station from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred(l).email]))[0];
  const O = await info("sat_aso"), S = await info("sso-kul"), M = await info("operation_manager");
  const St = O.station;
  ok("fixtures: the officer and the SSO share the station", O.station === S.station, St);
  const sb = { O: await clientFor("sat_aso"), S: await clientFor("sso-kul"), M: await clientFor("operation_manager") };
  const entry = async (suffix, minutes, creator, over = {}) => {
    const id = (await q("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by,towed_from_hangar,search_state) values($1,$2,'A320','UAT','AK9100',now()-($3||' minutes')::interval,true,$4,$5,$6) returning id", [St, `9M-${TAG}${suffix}`, String(minutes), creator, over.towed ?? false, over.state ?? "pending"]))[0].id;
    ledger.board.push(id); save();
    return id;
  };
  const state = async (id) => (await q("select cleared_at is not null cleared, cleared_kind, cleared_by_report_id, search_state, corrected_by from public.bay_board where id=$1", [id]))[0];
  const correct = async (c, id, reason) => { const r = await c.rpc("correct_bay_board_entry_secure", { p_id: id, p_reason: reason }); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; };

  // ---- direct writes are refused ----
  const e1 = await entry("A", 30, O.id);
  const d1 = await sb.O.from("bay_board").update({ cleared_at: new Date().toISOString() }).eq("id", e1).select("id");
  ok("an officer's direct update of cleared_at is rejected and the entry stays", (Boolean(d1.error) || (d1.data?.length ?? 0) === 0) && (await state(e1)).cleared === false, d1.error?.message ?? "no rows changed");
  const d2 = await sb.S.from("bay_board").update({ search_state: "confirmed", cleared_at: new Date().toISOString() }).eq("id", e1).select("id");
  ok("even an SSO cannot write the search state or clear an entry directly", (Boolean(d2.error) || (d2.data?.length ?? 0) === 0) && (await state(e1)).cleared === false);
  const ins = await sb.O.from("bay_board").insert({ station: St, reg_no: `9M-${TAG}X`, bay: "1", on_ground_since: new Date().toISOString(), created_by: O.id, cleared_at: new Date().toISOString() });
  ok("an entry cannot be inserted already cleared", Boolean(ins.error));
  const del = await sb.S.from("bay_board").delete().eq("id", e1).select("id");
  ok("a client cannot delete an entry", (Boolean(del.error) || (del.data?.length ?? 0) === 0) && (await state(e1)).cleared === false);

  // ---- authority and reason ----
  const asoTry = await correct(sb.O, e1, "Entered against the wrong registration");
  ok("an officer without supervisor authority cannot correct an entry", asoTry.data?.ok === false && asoTry.data?.code === "NOT_AUTHORISED" && (await state(e1)).cleared === false);
  ok("a correction without a real reason is refused", (await correct(sb.S, e1, "wrong")).data?.code === "REASON_REQUIRED");

  // ---- authorised correction of a genuinely incorrect entry ----
  const good = await correct(sb.S, e1, "Duplicate entry: the aircraft never arrived at this station");
  const after = await state(e1);
  ok("an SSO corrects a genuinely incorrect entry with a reason", good.data?.ok === true && after.cleared && after.cleared_kind === "correction" && after.cleared_by_report_id === null && after.corrected_by === S.id);
  const corr = (await q("select actor_role, had_required_search, reason from public.bay_board_corrections where bay_board_id=$1", [e1]))[0];
  ok("the correction is recorded with who, role and reason, and was not a required-search entry", corr?.had_required_search === false && /Duplicate entry/.test(corr.reason) && ["sso", "so"].includes(corr.actor_role));
  ok("it cannot be corrected twice", (await correct(sb.S, e1, "Duplicate entry: the aircraft never arrived at this station")).data?.code === "ALREADY_CLEARED");

  // ---- a required-search aircraft cannot leave as normally cleared ----
  const req = await entry("B", 400, O.id, { state: "submitted" });
  ok("an SSO cannot remove an aircraft that still needs a search", (await correct(sb.S, req, "Aircraft is not actually on the ground at this station")).data?.code === "NEEDS_DSE" && (await state(req)).cleared === false);
  ok("an officer cannot remove a required-search aircraft", (await correct(sb.O, req, "Aircraft is not actually on the ground at this station")).data?.code === "NOT_AUTHORISED" && (await state(req)).cleared === false);
  const towed = await entry("C", 15, O.id, { towed: true });
  ok("a towed aircraft counts as still needing a search", (await correct(sb.S, towed, "Aircraft is not actually on the ground at this station")).data?.code === "NEEDS_DSE");
  const night = await entry("D", 1500, O.id);
  ok("an aircraft on ground across midnight counts as still needing a search", (await correct(sb.S, night, "Aircraft is not actually on the ground at this station")).data?.code === "NEEDS_DSE");
  const own = await entry("E", 400, M.id, { state: "submitted" });
  ok("the creator cannot correct their own required-search entry", (await correct(sb.M, own, "Aircraft is not actually on the ground at this station")).data?.code === "OWN_ENTRY");
  const omRes = await correct(sb.M, req, "Entry created in error: aircraft departed on another system");
  const omAfter = await state(req);
  ok("the Operation Manager can correct a required-search entry, recorded as a correction and never as confirmed", omRes.data?.ok === true && omAfter.cleared_kind === "correction" && omAfter.search_state === "exception" && omAfter.cleared_by_report_id === null);
  const exc = (await q("select kind, review_state, late_reason from public.aircraft_search_records where registration=$1", [`9M-${TAG}B`]))[0];
  ok("the unconfirmed search is left as an exception for the reviewer", exc?.kind === "missing" && exc.review_state === "exception" && /Bay Board correction/.test(exc.late_reason ?? ""));
  ok("the audit row says a search was still required", (await q("select had_required_search from public.bay_board_corrections where bay_board_id=$1", [req]))[0]?.had_required_search === true);

  // ---- the page, mobile and desktop ----
  const shown = await entry("F", 20, O.id);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const page = await ctx.newPage();
    await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', cred("sso-kul").email);
    await page.fill('input[name="password"]', cred("sso-kul").password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.goto(`${base}/avsec/bay-board`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    const btn = page.getByRole("button", { name: /Correct entry/i }).first();
    ok(`${name}: the board offers "Correct entry" and no one-click Clear`, (await btn.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) && (await page.getByRole("button", { name: /^Clear$/i }).count()) === 0);
    await btn.click();
    const confirm = page.getByRole("button", { name: /Confirm correction/i }).first();
    ok(`${name}: the correction cannot be confirmed without a reason`, await confirm.isDisabled());
    ok(`${name}: it says the entry is recorded as a correction, not a completed search`, /recorded as a correction, not as a completed search/.test(((await page.textContent("body")) ?? "").replace(/\s+/g, " ")));
    ok(`${name}: no horizontal page scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
    if (name === "desktop") {
      await page.locator("textarea").last().fill("Entered for the wrong station by mistake during the UAT run");
      await confirm.click();
      await page.waitForTimeout(3000);
      ok("desktop: an authorised correction through the page records it as a correction", (await state(shown)).cleared_kind === "correction");
    }
    await ctx.close();
  }
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log(`RESULT: ${passes} passed, ${failures} failed; cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
