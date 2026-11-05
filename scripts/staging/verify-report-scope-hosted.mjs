#!/usr/bin/env node
// Hosted verification of canonical report scope: AK/MAA and D7/AAX reports filed by officers of ONE station and team, seen by that team's DSE and SO (both
// entities) and by no other team or station; the MAA Boss sees MAA only and the AAX Boss sees AAX only. Real signed-in sessions call the real secured functions
// on the staging database and Playwright loads the real pages. Fixture reports are created through the owner connection (the classification trigger derives their
// canonical scope and entity exactly as for a real submission), and removed by EXACT ledger id.
//
// Sessions needed: maa_boss, aax_boss, operation_manager, sso-kul (ALPHA SSO), sso-jhb (other station). A Charlie DSE and SO login, and an Alpha DSE and SO login,
// are used when credentials exist under the labels dse-charlie, so-charlie, dse-alpha, so-alpha; when they do not, those checks are printed as NOT VERIFIED and are
// never counted as passes.
//
// Usage: node --env-file=<staging env> scripts/staging/verify-report-scope-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-report-scope-hosted.mjs --run-id=<id> --cleanup-only
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
const credOf = (l) => accounts.find((a) => a.label === l);
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-reportscope.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, reports: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
let passes = 0, failures = 0, notVerified = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };
const skip = (label, why) => { notVerified += 1; console.log(`NOT VERIFIED: ${label} -- ${why}`); };

let pg = (await connectVerified()).client;
pg.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
const q = async (s, p) => (await pg.query(s, p)).rows;
const TABLES = { report_sec016: "report_id", report_sec014: "report_id" };

async function cleanup() {
  const report = {};
  const ids = ledger.reports.map((r) => r.id);
  if (ids.length) {
    report.notifications = (await pg.query("delete from public.user_notifications where dedup_key like any($1::text[]) returning id", [ledger.reports.map((r) => `dse_report:${r.table}:${r.id}:%`)])).rowCount;
    report.failures = (await pg.query("delete from public.report_notification_failures where source_id = any($1::uuid[]) returning id", [ids])).rowCount;
    report.acks = (await pg.query("delete from public.report_acknowledgements where report_id = any($1::uuid[]) returning id", [ids])).rowCount;
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    report.index = (await pg.query("delete from public.central_reports_index where source_id = any($1::uuid[]) returning id", [ids])).rowCount;
    for (const [t, c] of [["report_index_queue", "source_id"], ["sheet_sync_queue", "source_id"], ["report_versions", "report_id"]]) {
      try { report[t] = (await pg.query(`delete from public.${t} where ${c} = any($1::uuid[]) returning 1`, [ids])).rowCount; } catch { /* absent column or table */ }
    }
    for (const t of ["report_sec016", "report_sec014"]) report[t] = (await pg.query(`delete from public.${t} where id = any($1::uuid[]) and staff_name like $2 returning id`, [ids, `[UAT:${TAG}]%`])).rowCount;
    await pg.query("commit");
    try { report.audit = (await pg.query("delete from public.phase8_audit_log where action = 'report_acknowledged' and (detail->>'report_id') = any($1::text[]) returning 1", [ids])).rowCount; } catch { report.auditRetained = true; }
  }
  const remaining = {
    sec016: (await q("select count(*)::int n from public.report_sec016 where staff_name like $1", [`[UAT:${TAG}]%`]))[0].n,
    sec014: (await q("select count(*)::int n from public.report_sec014 where staff_name like $1", [`[UAT:${TAG}]%`]))[0].n,
    index: ids.length ? (await q("select count(*)::int n from public.central_reports_index where source_id = any($1::uuid[])", [ids]))[0].n : 0,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return Object.values(remaining).every((v) => v === 0);
}
if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const exists = async (label) => { const c = credOf(label); return c ? (await q("select 1 from auth.users where lower(email)=lower($1)", [c.email])).length === 1 : false; };
const clientFor = async (label) => {
  const c = credOf(label);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, c.email, c.password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
const rpc = async (c, fn, a) => { const r = await c.rpc(fn, a); return { data: r.data, error: r.error }; };
let browser;
try {
  const charlie = (await q(`select a.profile_id id from public.user_role_assignments a join public.role_definitions rd on rd.id=a.role_definition_id and rd.code='aso' join public.org_stations st on st.id=a.station_id and st.code='KUL - MAA' join public.org_teams t on t.id=a.team_id and t.name='CHARLIE' join public.profiles pr on pr.id=a.profile_id and pr.status='approved' where a.revoked_at is null order by a.profile_id limit 1`))[0];
  const dseCharlie = (await q(`select a.profile_id id from public.user_role_assignments a join public.role_definitions rd on rd.id=a.role_definition_id and rd.code='dse' join public.org_stations st on st.id=a.station_id and st.code='KUL - MAA' join public.org_teams t on t.id=a.team_id and t.name='CHARLIE' where a.revoked_at is null limit 1`))[0];
  ok("fixtures: a Charlie officer and the Charlie DSE exist", Boolean(charlie && dseCharlie));

  // ---- file one AK/MAA and one D7/AAX report from the Charlie officer; one carries the historical typed station KUL - AAX ----
  const cols = async (table, over) => {
    const c = await q("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null", [table]);
    const row = {};
    for (const x of c) { if (x.column_name in over) continue; row[x.column_name] = x.data_type === "uuid" ? crypto.randomUUID() : x.data_type === "boolean" ? false : /int|numeric|double/.test(x.data_type) ? 0 : x.data_type === "date" ? "2026-11-05" : /^time/.test(x.data_type) && !/stamp/.test(x.data_type) ? "08:00" : /timestamp/.test(x.data_type) ? new Date().toISOString() : x.data_type === "ARRAY" ? "{}" : x.data_type === "USER-DEFINED" ? undefined : "[UAT PROBE]"; }
    const all = { ...row, ...over }; for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
    return all;
  };
  const file = async (table, over) => {
    const all = await cols(table, { profile_id: charlie.id, status: "submitted", team: "CHARLIE", staff_name: `[UAT:${TAG}] Charlie officer`, ...over });
    const keys = Object.keys(all);
    const id = (await q(`insert into public.${table}(${keys.map((k) => `"${k}"`).join(",")}) values(${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, keys.map((k) => all[k])))[0].id;
    ledger.reports.push({ table, id }); save();
    await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: charlie.id, role: "authenticated" })]);
    await pg.query("select public.mark_report_ready_for_indexing($1,$2,0)", [table, id]);
    await pg.query("select set_config('request.jwt.claims', '', false)");
    return id;
  };
  const sec016 = { cargo_hold_checked: "YES", do_infmd: "NO", staff_frisked: "YES", flight_type: "departure", aircraft_type: "A 320", sta_std: "13:00", duty_date: "2026-11-05" };
  const ak = await file("report_sec016", { ...sec016, station: "KUL - AAX", flight: "AK5901", reg_no: `9M-${TAG}A` });
  const d7 = await file("report_sec016", { ...sec016, station: "KUL - MAA", flight: "D75902", reg_no: `9M-${TAG}B` });
  const s14 = await file("report_sec014", { station: "KUL - MAA", date_time_in: new Date().toISOString(), remark: "[UAT]", acknowledgement: true });
  await pg.query("select public.process_report_index_queue(100)");
  const rows = await q("select r.id, r.operating_entity_code ent, st.code canon_station, t.name canon_team, r.station typed from public.report_sec016 r left join public.org_stations st on st.id=r.org_station_id left join public.org_teams t on t.id=r.org_team_id where r.id = any($1::uuid[])", [[ak, d7]]);
  const akRow = rows.find((r) => r.id === ak), d7Row = rows.find((r) => r.id === d7);
  ok("the AK report is MAA and the D7 report is AAX, both on the officer's canonical KUL - MAA / CHARLIE", akRow.ent === "MAA" && d7Row.ent === "AAX" && rows.every((r) => r.canon_station === "KUL - MAA" && r.canon_team === "CHARLIE"));
  ok("the AK report keeps its typed station KUL - AAX (history is not rewritten)", akRow.typed === "KUL - AAX");

  // ---- alerts ----
  const alerts = async (table, id) => q("select recipient_profile_id r from public.user_notifications where dedup_key like $1", [`dse_report:${table}:${id}:%`]);
  const a1 = await alerts("report_sec016", ak), a2 = await alerts("report_sec016", d7), a3 = await alerts("report_sec014", s14);
  ok("the Charlie DSE got exactly one alert for the AK report (typed station KUL - AAX), the D7 report and the SEC014", [a1, a2, a3].every((a) => a.length === 1 && a[0].r === dseCharlie.id));
  await pg.query("select public.deliver_dse_report_notifications_v2('report_sec016',$1,'x','AK5901')", [ak]);
  ok("a retry adds no duplicate alert", (await alerts("report_sec016", ak)).length === 1);
  ok("no delivery failure was recorded for the fixture reports", (await q("select count(*)::int n from public.report_notification_failures where source_id = any($1::uuid[])", [[ak, d7, s14]]))[0].n === 0);

  // ---- bosses keep entity segregation; other teams and stations are refused ----
  const get = async (c, table, id) => rpc(c, "get_report_by_source_secure", { p_source_table: table, p_source_id: id });
  const maa = await clientFor("maa_boss"), aax = await clientFor("aax_boss"), om = await clientFor("operation_manager"), alpha = await clientFor("sso-kul"), jhb = await clientFor("sso-jhb");
  ok("the MAA Boss opens the AK report and is refused the D7 report", !(await get(maa, "report_sec016", ak)).error && Boolean((await get(maa, "report_sec016", d7)).error));
  ok("the AAX Boss opens the D7 report and is refused the AK report", !(await get(aax, "report_sec016", d7)).error && Boolean((await get(aax, "report_sec016", ak)).error));
  ok("the Operation Manager opens both", !(await get(om, "report_sec016", ak)).error && !(await get(om, "report_sec016", d7)).error);
  ok("an ALPHA team SSO is refused both Charlie reports by detail call", Boolean((await get(alpha, "report_sec016", ak)).error) && Boolean((await get(alpha, "report_sec016", d7)).error));
  ok("an SSO of another station is refused both", Boolean((await get(jhb, "report_sec016", ak)).error) && Boolean((await get(jhb, "report_sec016", d7)).error));
  const direct = await alpha.from("report_sec016").select("id").in("id", [ak, d7]);
  ok("a direct table read by another team returns nothing", (direct.data?.length ?? 0) === 0);
  ok("the Team Submission History function refuses a staff member who is not a DSE or SO", /available to a DSE or SO/.test((await rpc(alpha, "list_team_submissions_secure", { p_limit: 10 })).error?.message ?? ""));
  const ackTry = await alpha.from("report_acknowledgements").insert({ report_type: "sec016", report_id: ak, acknowledged_by: (await alpha.auth.getUser()).data.user.id });
  ok("an acknowledgment by another team is refused", Boolean(ackTry.error));

  // ---- DSE and SO sessions, when real logins exist ----
  for (const [label, team, who] of [["dse-charlie", true, "Charlie DSE"], ["so-charlie", true, "Charlie SO"], ["dse-alpha", false, "Alpha DSE"], ["so-alpha", false, "Alpha SO"]]) {
    if (!(await exists(label))) { skip(`${who} sees/does not see the Charlie reports (list, detail, acknowledge, direct API)`, `no ${label} login exists on staging`); continue; }
    const c = await clientFor(label);
    const list = await rpc(c, "list_team_submissions_secure", { p_limit: 100 });
    const ids = (list.data ?? []).map((r) => r.id);
    if (team) {
      ok(`the ${who} history lists the AK, D7 and SEC014 reports`, [ak, d7, s14].every((i) => ids.includes(i)));
      ok(`the ${who} opens both reports by detail call`, !(await get(c, "report_sec016", ak)).error && !(await get(c, "report_sec016", d7)).error);
      const ack = await c.from("report_acknowledgements").insert({ report_type: "sec016", report_id: label.startsWith("dse") ? ak : d7, acknowledged_by: (await c.auth.getUser()).data.user.id });
      ok(`the ${who} acknowledges within authority`, !ack.error, ack.error?.message ?? "");
    } else {
      ok(`the ${who} sees none of the Charlie reports and is refused them by direct call`, ![ak, d7, s14].some((i) => ids.includes(i)) && Boolean((await get(c, "report_sec016", ak)).error) && Boolean((await get(c, "report_sec016", d7)).error));
    }
  }
  const acks = (await q("select count(*)::int n from public.report_acknowledgements where report_id = any($1::uuid[])", [[ak, d7, s14]]))[0].n;
  const audits = (await q("select count(*)::int n from public.phase8_audit_log where action='report_acknowledged' and (detail->>'report_id') = any($1::text[])", [[ak, d7, s14]]))[0].n;
  ok("one audit record exists per acknowledgment action", audits === acks, `${audits}/${acks}`);

  // ---- pages ----
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const page = await ctx.newPage();
    const login = async (label) => {
      const c = credOf(label);
      await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
      await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
      await page.fill('input[name="email"]', c.email);
      await page.fill('input[name="password"]', c.password);
      await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
      await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    };
    await login("sso-kul");
    await page.goto(`${base}/avsec/history/team`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    ok(`${name}: a team SSO who is not a DSE or SO is sent back to My Submission History`, new URL(page.url()).pathname === "/avsec/history");
    await page.goto(`${base}/avsec/reports/view/sec016/${ak}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const t = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    ok(`${name}: opening a Charlie report by direct URL as an ALPHA SSO shows no report content`, !t.includes(`9M-${TAG}A`) && !t.includes("AK5901"));
    if (await exists("dse-charlie")) {
      await login("dse-charlie");
      await page.goto(`${base}/avsec/history/team`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      const body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
      ok(`${name}: the Charlie DSE Team Submission History shows AK and D7 rows with the required columns`, /AK5901/.test(body) && /D75902/.test(body) && /AK · MAA/.test(body) && /D7 · AAX/.test(body));
      ok(`${name}: no horizontal page scroll`, (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
      await page.goto(`${base}/avsec/reports/view/sec016/${d7}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      ok(`${name}: the Charlie DSE opens the D7 report detail`, /D75902/.test(((await page.textContent("body")) ?? "")));
    } else skip(`${name}: Team Submission History and report detail as the Charlie DSE`, "no dse-charlie login exists on staging");
    await ctx.close();
  }
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log(`RESULT: ${passes} passed, ${failures} failed, ${notVerified} NOT VERIFIED (no login available); cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
