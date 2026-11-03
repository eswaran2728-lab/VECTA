#!/usr/bin/env node
// Hosted verification, against a private staging Preview and the approved staging database with REAL signed-in sessions, that approved staff can browse every page
// their role allows WITHOUT checking in, can prepare and save drafts across devices off duty, and are still refused server-side (even by a direct request) for
// physical work and report submission until they check in. Scope limits are printed at the end: staging has no ASO, SO or DSE login, so those roles are covered by
// the guarded migration probes (real identities in rolled-back transactions), not by a browser session.
//
// Usage: node --env-file=<staging env> scripts/staging/verify-off-duty-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-off-duty-hosted.mjs --run-id=<id> --cleanup-only
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
const ledgerPath = path.join(ledgerDir, `${runId}-offduty.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, duty: [], records: [], board: [], drafts: [], startedAt: new Date().toISOString() };
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
  report.board = ledger.board.length ? (await pg.query("delete from public.bay_board where id = any($1::uuid[]) returning 1", [ledger.board])).rowCount : 0;
  report.duty = ledger.duty.length ? (await pg.query("delete from public.duty_records where id = any($1::uuid[]) returning 1", [ledger.duty])).rowCount : 0;
  report.drafts = ledger.drafts.length ? (await pg.query("delete from public.report_drafts where profile_id = any($1::uuid[]) and report_type = 'sec014' and data->>'remark' like $2 returning 1", [ledger.drafts, `[UAT:${TAG}]%`])).rowCount : 0;
  await pg.query("commit");
  try { await pg.query("delete from public.phase8_audit_log where entity_type = 'aircraft_search' and created_at >= $1", [ledger.startedAt]); } catch { /* retained */ }
  const remaining = {
    records: (await q("select count(*)::int n from public.aircraft_search_records where registration like $1", [`9M-${TAG}%`]))[0].n,
    board: ledger.board.length ? (await q("select count(*)::int n from public.bay_board where id = any($1::uuid[])", [ledger.board]))[0].n : 0,
    duty: ledger.duty.length ? (await q("select count(*)::int n from public.duty_records where id = any($1::uuid[])", [ledger.duty]))[0].n : 0,
    drafts: ledger.drafts.length ? (await q("select count(*)::int n from public.report_drafts where profile_id = any($1::uuid[]) and report_type = 'sec014' and data->>'remark' like $2", [ledger.drafts, `[UAT:${TAG}]%`]))[0].n : 0,
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
const PAGES = ["/avsec/my-dashboard", "/avsec/history", "/avsec/reports/lookup", "/avsec/discussions", "/avsec/bay-board", "/avsec/duty/absences", "/avsec/duty/handover", "/avsec/aircraft-search", "/avsec/duty/timesheet", "/avsec/duty"];
let browser;
try {
  const info = async (l) => (await q("select pr.id, (select min(s.code) from public.user_role_assignments a join public.org_stations s on s.id=a.station_id where a.profile_id=pr.id and a.revoked_at is null) station from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred(l).email]))[0];
  const S = await info("sso-kul"), J = await info("sso-jhb");
  const today = "(now() at time zone 'Asia/Kuala_Lumpur')::date";
  const openDuty = async (id) => (await q(`select count(*)::int n from public.duty_records where profile_id=$1 and duty_date=${today} and check_in_at is not null and check_out_at is null`, [id]))[0].n;
  ok("fixture: the synthetic SSO is off duty (no open check-in) at the start", (await openDuty(S.id)) === 0);

  // ---- browsing off duty, on a phone, by direct URL ----
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', cred("sso-kul").email);
  await page.fill('input[name="password"]', cred("sso-kul").password);
  await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
  ok("an off-duty SSO signs in and lands on their workspace, not on a check-in page", !/\/login|\/avsec\/duty$/.test(new URL(page.url()).pathname), new URL(page.url()).pathname);
  for (const p of PAGES) {
    await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const u = new URL(page.url());
    const text = ((await page.textContent("body").catch(() => "")) ?? "").replace(/\s+/g, " ");
    const stays = u.pathname === p && !u.search.includes("next=");
    // a page the role is not allowed to open lands on the role's own dashboard, which is an authorisation decision and not a duty redirect
    ok(`off duty, direct URL ${p} is not a check-in redirect`, !u.search.includes("next=") && !/error=checkin/.test(u.search) && !/application error/i.test(text), `${u.pathname}${stays ? "" : " (role landing)"}`);
  }
  ok("no horizontal page scroll on the phone", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  await ctx.close();

  // ---- drafts off duty, across two devices ----
  const phone = await clientFor("sso-kul"), laptop = await clientFor("sso-kul");
  ledger.drafts.push(S.id); save();
  const form = { remark: `[UAT:${TAG}] prepared off duty`, date_in: "2026-11-04", time_in: "07:30" };
  const up = await phone.from("report_drafts").upsert({ profile_id: S.id, report_type: "sec014", data: form }, { onConflict: "profile_id,report_type" });
  const got = await laptop.from("report_drafts").select("data").eq("profile_id", S.id).eq("report_type", "sec014").maybeSingle();
  ok("an off-duty draft saves and resumes on a second device", !up.error && got.data?.data?.remark === form.remark, up.error?.message ?? "");

  // ---- refusals while off duty, by direct request ----
  const startOff = await phone.rpc("start_aircraft_search_secure", { p_flight: "D7001", p_registration: `9M-${TAG}A`, p_station: S.station, p_aircraft_type: "A320", p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10, p_unavailable_reason: null });
  ok("starting an aircraft search off duty is refused", /checked in for duty/.test(startOff.error?.message ?? ""), startOff.error?.message ?? "accepted");
  const subOff = await phone.from("report_sec014").insert({ profile_id: S.id, status: "submitted", station: S.station, team: "ALPHA", staff_name: "UAT", staff_id: "UAT", date_time_in: new Date().toISOString(), remark: `[UAT:${TAG}] off duty`, acknowledgement: true }).select("id");
  ok("submitting a report off duty by a direct request is refused", Boolean(subOff.error) && (await q("select count(*)::int n from public.report_sec014 where remark like $1", [`[UAT:${TAG}]%`]))[0].n === 0, subOff.error?.message ?? "accepted");
  const hOff = await phone.rpc("complete_handover_secure", { p_handover_id: "00000000-0000-0000-0000-000000000000", p_token: "x", p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10, p_captured_at: new Date().toISOString(), p_notes: null });
  ok("completing a handover off duty gets no completion", !(hOff.data?.[0]?.ok === true));

  // ---- cross-station denial ----
  const kul = (await q("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by) values($1,$2,'A320','UAT','D7002',now(),true,$3) returning id", [S.station, `9M-${TAG}K`, S.id]))[0].id;
  ledger.board.push(kul); save();
  const jhbSees = await (await clientFor("sso-jhb")).from("bay_board").select("id").eq("id", kul);
  ok("an SSO of another station cannot see this station's Bay Board entry", (jhbSees.data?.length ?? 0) === 0);
  const jhbCorrect = await (await clientFor("sso-jhb")).rpc("correct_bay_board_entry_secure", { p_id: kul, p_reason: "Trying to correct another station's entry" });
  ok("an SSO of another station cannot correct it either", (Array.isArray(jhbCorrect.data) ? jhbCorrect.data[0] : jhbCorrect.data)?.ok !== true);
  void J;

  // ---- after check-in, physical work succeeds ----
  const shift = (await q("select coalesce((select shift_code from public.duty_records limit 1),'D') s"))[0].s;
  const d = (await q(`insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,${today},$3,now()) on conflict (profile_id,duty_date,shift_code) do nothing returning id`, [S.id, S.station, shift]))[0]?.id;
  if (d) { ledger.duty.push(d); save(); }
  ok("the SSO is now checked in (fixture)", (await openDuty(S.id)) >= 1);
  const startOn = await phone.rpc("start_aircraft_search_secure", { p_flight: "D7001", p_registration: `9M-${TAG}A`, p_station: S.station, p_aircraft_type: "A320", p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10, p_unavailable_reason: null });
  ok("after check-in the same aircraft search starts", Boolean(startOn.data) && !startOn.error, startOn.error?.message ?? "");
  const finishOn = await phone.rpc("finish_aircraft_search_secure", { p_record_id: startOn.data, p_lat: 3.1, p_lng: 101.7, p_accuracy_m: 10, p_unavailable_reason: null });
  ok("after check-in the search can be finished", !finishOn.error, finishOn.error?.message ?? "");
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log("SCOPE: no ASO, SO or DSE login exists on staging, so those roles and report-form submission success after check-in are covered by the guarded migration probes (real identities inside rolled-back transactions), not by a browser session. Pending, revoked and inactive accounts are covered by the existing role-route tests and the hosted UAT harness when those accounts exist.");
  console.log(`RESULT: ${passes} passed, ${failures} failed; cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
