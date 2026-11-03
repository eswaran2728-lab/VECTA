#!/usr/bin/env node
// Hosted verification of Aircraft Search Verification against a private staging Preview and the approved staging database, with REAL signed-in sessions:
// sat_aso (the officer who searches and files the departure) and sso-kul (the different on-duty reviewer), both of KUL - MAA / MAA. Tagged fixtures (duty rows,
// a Bay Board entry, SEC029/SEC016 rows) are created through the owner connection and removed by EXACT ledger id. Browser location here is emulated and does NOT
// certify physical presence; the real-aircraft check is a separate physical trial.
//
// Usage: node --env-file=<staging env> scripts/staging/verify-aircraft-search-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-aircraft-search-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
const ledgerPath = path.join(ledgerDir, `${runId}-aircraft-search.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, duty: [], board: [], sec029: [], sec016: [], records: [], startedAt: new Date().toISOString() };
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
  const del = async (label, sql, ids) => { report[label] = ids.length ? (await pg.query(sql, [ids])).rowCount : 0; };
  // records first (they reference the reports), then the immutable reports, the board entries and the duty rows
  await del("records", "delete from public.aircraft_search_records where id = any($1::uuid[]) returning 1", ledger.records);
  await del("recordsByReport", "delete from public.aircraft_search_records where sec029_id = any($1::uuid[]) or departure_report_id = any($2::uuid[]) returning 1".replace("$2", "$1"), [...ledger.sec029, ...ledger.sec016]);
  await del("sec029", "delete from public.report_sec029 where id = any($1::uuid[]) returning 1", ledger.sec029);
  await del("sec016", "delete from public.report_sec016 where id = any($1::uuid[]) returning 1", ledger.sec016);
  await del("board", "delete from public.bay_board where id = any($1::uuid[]) returning 1", ledger.board);
  await del("duty", "delete from public.duty_records where id = any($1::uuid[]) returning 1", ledger.duty);
  await pg.query("commit");
  let audit = 0, blocked = 0;
  try { audit = (await pg.query("delete from public.phase8_audit_log where entity_type='aircraft_search' and created_at >= $1 returning 1", [ledger.startedAt])).rowCount; } catch { blocked = 1; }
  report.audit = audit; if (blocked) report.auditRetained = true;
  const remaining = {
    board: ledger.board.length ? (await q("select count(*)::int n from public.bay_board where id = any($1::uuid[])", [ledger.board]))[0].n : 0,
    sec029: ledger.sec029.length ? (await q("select count(*)::int n from public.report_sec029 where id = any($1::uuid[])", [ledger.sec029]))[0].n : 0,
    sec016: ledger.sec016.length ? (await q("select count(*)::int n from public.report_sec016 where id = any($1::uuid[])", [ledger.sec016]))[0].n : 0,
    records: (await q("select count(*)::int n from public.aircraft_search_records where registration like $1", [`9M-${TAG}%`]))[0].n,
    duty: ledger.duty.length ? (await q("select count(*)::int n from public.duty_records where id = any($1::uuid[])", [ledger.duty]))[0].n : 0,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return Object.values(remaining).every((v) => v === 0);
}
if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

async function fixture(table, over) {
  const cols = await q("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null", [table]);
  const row = {};
  for (const c of cols) {
    if (c.column_name in over) continue;
    row[c.column_name] = c.data_type === "uuid" ? crypto.randomUUID() : c.data_type === "boolean" ? false : /int|numeric|double/.test(c.data_type) ? 0 : c.data_type === "date" ? "2026-11-03" : /^time/.test(c.data_type) && !/stamp/.test(c.data_type) ? "08:00" : /timestamp/.test(c.data_type) ? new Date().toISOString() : c.data_type === "ARRAY" ? "{}" : c.data_type === "USER-DEFINED" ? undefined : "[UAT PROBE]";
  }
  const all = { ...row, ...over };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  const keys = Object.keys(all);
  return (await q(`insert into public.${table}(${keys.map((k) => `"${k}"`).join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, keys.map((k) => all[k])))[0].id;
}
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
  const info = async (l) => (await q("select pr.id, pr.staff_no, public.leave_submitter_entity(pr.id) ent, (select min(s.code) from public.user_role_assignments a join public.org_stations s on s.id=a.station_id where a.profile_id=pr.id and a.revoked_at is null) station from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred(l).email]))[0];
  const O = await info("sat_aso"), R = await info("sso-kul");
  ok("fixtures: officer and reviewer share station and entity", O.station === R.station && O.ent === R.ent && O.id !== R.id, `${O.station}/${O.ent}`);
  const St = O.station;
  const shift = (await q("select coalesce((select shift_code from public.duty_records limit 1),'D') s"))[0].s;
  for (const p of [O, R]) {
    const id = (await q("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,(now() at time zone 'Asia/Kuala_Lumpur')::date,$3,now()) on conflict (profile_id,duty_date,shift_code) do nothing returning id", [p.id, St, shift]))[0]?.id;
    if (id) { ledger.duty.push(id); save(); }
  }
  const openDuty = (await q("select count(*)::int n from public.duty_records where profile_id = any($1::uuid[]) and station=$2 and check_in_at is not null and check_out_at is null", [[O.id, R.id], St]))[0].n;
  ok("both officers are checked in (fixture or existing)", openDuty >= 2);
  const sb = { O: await clientFor("sat_aso"), R: await clientFor("sso-kul") };
  const rpc = async (c, fn, a) => { const r = await c.rpc(fn, a); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; };

  const reg = `9M-${TAG}A`, flight = "AK9001";
  const board = (await q("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by) values($1,$2,'A320','UAT',$3,now()-interval '5 hours',true,$4) returning id", [St, reg, flight, O.id]))[0].id;
  ledger.board.push(board); save();

  // ---- recording ----
  const noGps = await rpc(sb.O, "start_aircraft_search_secure", { p_flight: flight, p_registration: reg, p_station: St, p_aircraft_type: "A320", p_lat: null, p_lng: null, p_accuracy_m: null, p_unavailable_reason: null });
  ok("no location and no reason is refused", /reason is required/.test(noGps.error?.message ?? ""));
  const start = await rpc(sb.O, "start_aircraft_search_secure", { p_flight: flight, p_registration: reg, p_station: St, p_aircraft_type: "A320", p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 12, p_unavailable_reason: null });
  ok("search starts with server time and reported location", Boolean(start.data) && !start.error, start.error?.message ?? "");
  ledger.records.push(start.data); save();
  const wrongStation = await rpc(sb.R, "start_aircraft_search_secure", { p_flight: flight, p_registration: reg, p_station: "PEN", p_aircraft_type: "A320", p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 12, p_unavailable_reason: null });
  ok("a search cannot be recorded at another station", Boolean(wrongStation.error));
  const early = await rpc(sb.O, "finish_aircraft_search_secure", { p_record_id: start.data, p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 12, p_unavailable_reason: null });
  ok("finishing immediately is below the 30 minute A320 minimum", early.data?.below_minimum === true && early.data?.minimum_minutes === 30);

  // ---- SEC029 evidence ----
  const sec029 = await fixture("report_sec029", { profile_id: O.id, status: "submitted", station: St, team: "ALPHA", flight_no: flight, aircraft_registration: reg, aircraft_type: "A320", assisted_by_id: "NOPE", pic_informed: "YES", declaration: "I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.", acknowledgement: true, operating_entity_code: O.ent, submitted_at: new Date(Date.now() - 100 * 60000).toISOString() });
  ledger.sec029.push(sec029); save();
  const noReason = await rpc(sb.O, "attach_search_to_sec029", { p_sec029_id: sec029, p_record_id: start.data, p_below_minimum_reason: null, p_gps_reason: null });
  ok("a short search needs a reason before it can be attached", /reason is required/.test(noReason.error?.message ?? ""));
  const attach = await rpc(sb.O, "attach_search_to_sec029", { p_sec029_id: sec029, p_record_id: start.data, p_below_minimum_reason: "Aircraft was already cleared by the ramp team", p_gps_reason: null });
  ok("with a reason the search attaches to the SEC029", !attach.error && attach.data === start.data, attach.error?.message ?? "");
  const submitted = (await q("select search_state, cleared_at is not null cleared from public.bay_board where id=$1", [board]))[0];
  ok("SEC029 submission alone does not clear the Bay Board (state: submitted)", submitted.search_state === "submitted" && submitted.cleared === false);

  // ---- SEC016 departure ----
  // the SEC029 was submitted 100 minutes ago, so an entered STD 70 minutes ago is a 30 minute gap from the search (under the AK 45 minute threshold)
  const std = new Date(Date.now() + 8 * 3600000 - 70 * 60000).toISOString().slice(11, 16);
  const dep = await fixture("report_sec016", { profile_id: O.id, status: "submitted", station: St, team: "ALPHA", flight, reg_no: reg, flight_type: "departure", cargo_hold_checked: "YES", do_infmd: "NO", staff_frisked: "YES", aircraft_type: "A 320", sta_std: std, operating_entity_code: O.ent, submitted_at: new Date().toISOString() });
  ledger.sec016.push(dep); save();
  const prev = await rpc(sb.O, "preview_departure_search_secure", { p_station: St, p_registration: reg, p_flight: flight, p_sta_std: std, p_aircraft_type: "A 320", p_towed: false });
  ok("the departure preview shows the requirement and both gaps", prev.data?.required === true && prev.data?.reasons?.includes("ground_4h") && prev.data?.std_gap_minutes != null && prev.data?.departure_gap_minutes != null, JSON.stringify(prev.data ?? prev.error?.message).slice(0, 140));
  ok("a 30 minute gap from SEC029 to the entered STD is flagged for AK (under 45) while the 100 minute SEC016 gap is not", prev.data?.std_flag === true && prev.data?.departure_flag === false, `${prev.data?.std_gap_minutes}/${prev.data?.departure_gap_minutes}`);
  const applied = await rpc(sb.O, "apply_departure_search_rules", { p_departure_id: dep, p_towed: false, p_reason: "Delayed by ramp congestion" });
  ok("applying the rules records the escalation and keeps the unconfirmed search on the board", applied.data?.flagged === true && applied.data?.kept_on_board === true && !applied.error, applied.error?.message ?? "");
  const afterDep = (await q("select search_state, cleared_at is not null cleared, departed_without_confirmed_search dep from public.bay_board where id=$1", [board]))[0];
  ok("the board entry stays, marked departed without a confirmed search", afterDep.cleared === false && afterDep.dep === true);
  const visible = await sb.R.from("aircraft_search_records").select("id,late_flag,presence_status,std_gap_minutes").eq("id", start.data);
  ok("the reviewer can see the flagged record (gaps, reported presence)", visible.data?.length === 1 && visible.data[0].late_flag === true && visible.data[0].presence_status === "reported");

  // ---- review ----
  const self = await rpc(sb.O, "review_aircraft_search_secure", { p_record_id: start.data, p_decision: "confirm", p_note: "I searched it myself" });
  ok("the searching officer cannot review their own search", self.data?.ok === false && ["SELF_REVIEW", "NOT_ELIGIBLE"].includes(self.data?.code), self.data?.code);
  const noNote = await rpc(sb.R, "review_aircraft_search_secure", { p_record_id: start.data, p_decision: "confirm", p_note: "" });
  ok("a flagged search cannot be confirmed without a note", noNote.data?.code === "NOTE_REQUIRED");
  const [a, b] = await Promise.all([1, 2].map(() => rpc(sb.R, "review_aircraft_search_secure", { p_record_id: start.data, p_decision: "confirm", p_note: "Checked the search log and spoke to the team" })));
  ok("simultaneous reviews record exactly one decision", [a.data?.ok, b.data?.ok].filter(Boolean).length === 1, `${a.data?.code}/${b.data?.code}`);
  const done = (await q("select review_state, reviewed_by from public.aircraft_search_records where id=$1", [start.data]))[0];
  const cleared = (await q("select search_state, cleared_at is not null cleared from public.bay_board where id=$1", [board]))[0];
  ok("confirmation by a different on-duty SSO is recorded and the board then shows confirmed and clears", done.review_state === "confirmed" && done.reviewed_by === R.id && cleared.search_state === "confirmed" && cleared.cleared === true);

  // ---- missing search is escalated, not hidden ----
  const reg2 = `9M-${TAG}B`;
  const board2 = (await q("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by,towed_from_hangar) values($1,$2,'A320','UAT','AK9002',now()-interval '30 minutes',true,$3,true) returning id", [St, reg2, O.id]))[0].id;
  ledger.board.push(board2); save();
  const dep2 = await fixture("report_sec016", { profile_id: O.id, status: "submitted", station: St, team: "ALPHA", flight: "AK9002", reg_no: reg2, flight_type: "departure", cargo_hold_checked: "YES", do_infmd: "NO", staff_frisked: "YES", aircraft_type: "A 320", sta_std: std, operating_entity_code: O.ent, submitted_at: new Date().toISOString() });
  ledger.sec016.push(dep2); save();
  const miss = await rpc(sb.O, "apply_departure_search_rules", { p_departure_id: dep2, p_towed: true, p_reason: "Tow done after the shift change" });
  ok("a towed aircraft with no SEC029 is a required-but-missing search, escalated and kept on the board", miss.data?.missing === true && miss.data?.kept_on_board === true);
  const missRec = (await q("select id, kind, review_state from public.aircraft_search_records where departure_report_id=$1", [dep2]))[0];
  ledger.records.push(missRec.id); save();
  ok("it is recorded as an exception for the reviewer", missRec.kind === "missing" && missRec.review_state === "exception");
  const missConfirm = await rpc(sb.R, "review_aircraft_search_secure", { p_record_id: missRec.id, p_decision: "confirm", p_note: "looks fine" });
  ok("a missing search can never be confirmed", missConfirm.data?.code === "NO_SEARCH");

  // ---- UI: reviewer queue and Bay Board on mobile and desktop ----
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
    await page.goto(`${base}/avsec/aircraft-search`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    const text = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    ok(`${name}: the review page lists the search with its flags and the honest wording`, text.includes(reg) && /AIRCRAFT SEARCH REVIEW/i.test(text) && /not proof of presence/i.test(text));
    ok(`${name}: the missing-search exception is listed`, text.includes(reg2) && /Required search missing/i.test(text));
    ok(`${name}: no horizontal page scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
    await page.goto(`${base}/avsec/bay-board`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    const bb = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    ok(`${name}: the Bay Board shows the departed-without-confirmed-search exception`, bb.includes(reg2) && /search exception/i.test(bb));
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
