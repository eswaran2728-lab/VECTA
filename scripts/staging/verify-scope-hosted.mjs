#!/usr/bin/env node
// Hosted verification, against a private staging Preview and the approved staging database, of:
//   * DSE leave isolation (station AND team), Operation Manager / Main Enforcement oversight, Hub SE hub isolation (pending-leave list and review),
//   * Operation-Manager-only duty-zone writes with ordinary staff still reading zones and checking in,
//   * the shift handover summary (authorized unfinished movements shown, unauthorized ones excluded).
// It creates TAGGED fixtures (leave notices, one roster row, two synthetic movements, one zone) through the owner connection, exercises the real
// sessions, and removes EXACTLY what it created in a finally block (a ledger outside the repository allows --cleanup-only after a crash). Credentials come
// from the private files outside the repository and are never printed. Screenshots go to %TEMP%\vecta-scope-evidence.
//
// Usage: node --env-file=.env.local scripts/staging/verify-scope-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=.env.local scripts/staging/verify-scope-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
const CLEANUP_ONLY = args.includes("--cleanup-only");
if (!runId || !/^[a-z0-9-]{6,40}$/i.test(runId)) throw new Error("--run-id=<6-40 chars [a-z0-9-]> is required");
if (!CLEANUP_ONLY && !base?.startsWith("https://")) throw new Error("--url=https://<staging preview> is required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || (base ?? "").includes(FORBIDDEN_REF)) throw new Error("production reference refused");

const TAG = `[UAT:${runId}]`;
const accounts = loadCurrentCredentials();
const manifest = loadCurrentManifest();
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const uid = (l) => manifest.find((a) => a.label === l)?.authUserId ?? (() => { throw new Error(`no manifest entry for ${l}`); })();
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-scope.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, notices: [], roster: [], movements: [], zones: [], duty: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
const evDir = path.join(os.tmpdir(), "vecta-scope-evidence", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(evDir, { recursive: true });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };
const setEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The host network has dropped connections mid-run before: never let a dead connection crash the process (the ledger-driven cleanup must always run).
let pg = (await connectVerified()).client;
const wire = (c) => c.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
wire(pg);
const reconnect = async () => { try { await pg.end(); } catch { /* already dead */ } pg = (await connectVerified()).client; wire(pg); };
const DEAD = /Connection terminated|ECONNRESET|read ECONN|connection error|Client was closed/i;
const q = async (s, p) => { for (let i = 0; ; i += 1) { try { return (await pg.query(s, p)).rows; } catch (e) { if (i >= 2 || !DEAD.test(String(e.message))) throw e; await reconnect(); } } };

async function cleanup() {
  await reconnect(); // always cleanup on a fresh connection
  const report = {};
  const d = await pg.query("delete from public.duty_records where id = any($1::uuid[]) returning id", [ledger.duty]);
  report.duty = d.rowCount;
  const rr = await pg.query("delete from public.team_rosters where id = any($1::uuid[]) and notes = $2 returning id", [ledger.roster, TAG]);
  report.roster = rr.rowCount;
  const noteKeys = ledger.notices.map((id) => `phase8_leave_${id}_%`);
  let nn = 0;
  for (const k of noteKeys) nn += (await pg.query("delete from public.user_notifications where dedup_key like $1 returning id", [k])).rowCount;
  report.notifications = nn;
  const n = await pg.query("delete from public.absence_notices where id = any($1::uuid[]) and remarks = $2 returning id", [ledger.notices, TAG]);
  report.notices = n.rowCount;
  const z = await pg.query("delete from public.duty_zones where id = any($1::uuid[]) and name like $2 returning id", [ledger.zones, `${TAG}%`]);
  report.zones = z.rowCount;
  await pg.query("begin");
  await pg.query("set local session_replication_role = replica");
  const t = await pg.query("delete from public.transactions where id = any($1::uuid[]) and driver_name like $2 returning id", [ledger.movements, `${TAG}%`]);
  await pg.query("commit");
  report.movements = t.rowCount;
  const remaining = {
    notices: (await q("select count(*)::int n from public.absence_notices where remarks = $1", [TAG]))[0].n,
    roster: (await q("select count(*)::int n from public.team_rosters where notes = $1", [TAG]))[0].n,
    zones: (await q("select count(*)::int n from public.duty_zones where name like $1", [`${TAG}%`]))[0].n,
    movements: (await q("select count(*)::int n from public.transactions where driver_name like $1", [`${TAG}%`]))[0].n,
    duty: (await q("select count(*)::int n from public.duty_records where id = any($1::uuid[])", [ledger.duty]))[0].n,
  };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return Object.values(remaining).every((v) => v === 0);
}

if (CLEANUP_ONLY) {
  const clean = await cleanup();
  await pg.end();
  process.exit(clean ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const clientFor = async (label) => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, cred(label).email, cred(label).password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
const hosts = new Set();
const browserErrors = [];
async function pageFor(browser, label, viewport = { width: 1366, height: 900 }, colorScheme = "light", opts = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, colorScheme, ...opts });
    ctx.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* ignore */ } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => browserErrors.push(`${label}: ${String(e.message).slice(0, 100)}`));
    page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js|Failed to load resource/.test(m.text())) browserErrors.push(`${label}: ${m.text().slice(0, 100)}`); });
    await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', cred(label).email);
    await page.fill('input[name="password"]', cred(label).password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    if (!/\/login/.test(new URL(page.url()).pathname)) return { ctx, page };
    await ctx.close();
    await new Promise((r) => setTimeout(r, 20000 * attempt)); // sign-in throttling is not a credential failure
  }
  throw new Error(`${label}: could not sign in to the Preview`);
}
const go = async (page, p) => {
  // a transient host network change (ERR_NETWORK_*) is retried; any other failure surfaces
  for (let attempt = 1; ; attempt += 1) {
    try { await page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" }); break; } catch (e) { if (attempt >= 3 || !/ERR_NETWORK|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 4000 * attempt)); }
  }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  return new URL(page.url()).pathname;
};
const bodyText = async (page) => (await page.textContent("body")) ?? "";

let browser;
try {
  // ---- fixtures ----
  const today = (await q("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d"))[0].d;
  const mkNotice = async (userLabel, station, team) => {
    const r = (await q(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, remarks, leave_type, start_date, end_date, approval_status, status)
       values ($1, $2, 'ASO', $3, $4, current_date + 30, now(), $5, 'annual', current_date + 30, current_date + 31, 'pending', 'green') returning id`,
      [uid(userLabel), `${TAG} ${userLabel}`, station, team, TAG]))[0].id;
    ledger.notices.push(r); save();
    return r;
  };
  await pg.query("begin"); await pg.query("set local session_replication_role = replica");
  const F1 = await mkNotice("aso-kul", "KUL - MAA", "ALPHA"); // the DSE's own station AND team
  const F2 = await mkNotice("sso-kul", "KUL - MAA", "BRAVO"); // another team at the same station
  const F3 = await mkNotice("aso", "PEN", "ALPHA"); // another station and hub (the Hub SE's hub)
  await pg.query("commit");
  const hasOps = (await q("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='team_rosters' and column_name='ops_group'"))[0].n === 1;
  const ro = (await q(`insert into public.team_rosters (station, team, roster_date, shift_code, start_time, end_time, notes, set_by${hasOps ? ", ops_group" : ""}) values ('KUL - MAA', 'ALPHA', $1::date, 'M', null, null, $2, $3${hasOps ? ", 'operation_avsec'" : ""}) returning id`, [today, TAG, uid("dse")]))[0].id;
  ledger.roster.push(ro); save();
  // DSE is a shift-based role: under the duty check-in gate, a shift-based user must be checked in
  // on duty to open operational routes like the roster administration screen.
  const dseDuty = (await q(
    `insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, check_in_inside_fence, status, handover_notes)
     values ($1, 'KUL - MAA', $2::date, 'M', now(), true, 'present', $3) returning id`,
    [uid("dse"), today, TAG],
  ))[0].id;
  ledger.duty.push(dseDuty); save();
  const aoc = (await q("select id from public.aocs where code = 'MY'"))[0].id;
  const stationId = async (c) => (await q("select id from public.org_stations where code = $1", [c]))[0].id;
  await pg.query("begin"); await pg.query("set local session_replication_role = replica");
  const mkTx = async (number, station) => {
    const r = (await q(
      `insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
       values ($1,$2,'OUTBOUND','UAT-VEH',$3,'UAT-DRV','UAT-SEAL','CREATED','AIRCRAFT',$4,'AK9001',$5) returning id`,
      [number, aoc, `${TAG} SYNTHETIC`, await stationId(station), uid("caterlink-driver")]))[0].id;
    ledger.movements.push(r); save();
  };
  await mkTx("ICMS-2026-990001", "PEN");
  await mkTx("ICMS-2026-990002", "JHB");
  await pg.query("commit");
  console.log(`fixtures: 3 leave notices, 1 roster row, 1 duty row, 2 movements (ledger ${path.basename(ledgerPath)})`);

  // ---- 1. leave: DSE team isolation, oversight, Hub SE hub isolation (real sessions) ----
  const mine = async (sb) => ((await sb.from("absence_notices").select("id").eq("remarks", TAG)).data ?? []).map((r) => r.id);
  const dse = await clientFor("dse");
  ok("DSE (KUL - MAA / ALPHA) lists only its own team's leave notice", setEq(await mine(dse), [F1]));
  const upd = await dse.from("absence_notices").update({ review_notes: "probe" }).eq("id", F2).select("id");
  ok("DSE cannot update another team's leave notice at the same station through the table", !upd.error ? (upd.data ?? []).length === 0 : true, upd.error?.message?.slice(0, 60));
  const revF2 = await dse.rpc("review_leave_request_secure", { p_notice_id: F2, p_action: "approve" });
  ok("DSE cannot review another team's notice at the same station (secure RPC)", !!revF2.error && /No active Phase 3 role assignment grants authority/.test(revF2.error.message), revF2.error?.message?.slice(0, 80));
  const revF3 = await dse.rpc("review_leave_request_secure", { p_notice_id: F3, p_action: "approve" });
  ok("DSE cannot review another station's notice (secure RPC)", !!revF3.error && /No active Phase 3 role assignment grants authority/.test(revF3.error.message), revF3.error?.message?.slice(0, 80));
  const om = await clientFor("operation_manager");
  ok("Operation Manager keeps department oversight: reads every notice", setEq(await mine(om), [F1, F2, F3]));
  const me = await clientFor("main_enforcement");
  ok("Main Enforcement keeps its separate read authority", setEq(await mine(me), [F1, F2, F3]));
  const hub = await clientFor("hub_se");
  ok("Hub SE reads none of these through the table (no table policy for Hub SE)", (await mine(hub)).length === 0);
  const pend = await hub.rpc("list_pending_leave_for_reviewer_secure");
  const pendIds = (pend.data ?? []).filter((r) => r.remarks === TAG).map((r) => r.id);
  ok("Hub SE pending-leave list: its own hub's notice (PEN) is listed; the KUL hub's notices (either team) are not", !pend.error && pendIds.includes(F3) && !pendIds.includes(F1) && !pendIds.includes(F2), JSON.stringify({ n: pendIds.length, f3: pendIds.includes(F3) }));
  const hubRevF2 = await hub.rpc("review_leave_request_secure", { p_notice_id: F2, p_action: "approve" });
  ok("Hub SE cannot review a notice in another hub (KUL)", !!hubRevF2.error && /No active Phase 3 role assignment grants authority/.test(hubRevF2.error.message), hubRevF2.error?.message?.slice(0, 80));
  const revF1 = await dse.rpc("review_leave_request_secure", { p_notice_id: F1, p_action: "approve" });
  ok("DSE CAN review its own team's notice (secure RPC)", !revF1.error, revF1.error?.message?.slice(0, 80));
  const asoKul = await clientFor("aso-kul");
  ok("a staff member still reads their own leave notice", (await mine(asoKul)).includes(F1) && !(await mine(asoKul)).includes(F2));

  // ---- 2. zones: Operation Manager only writes; ordinary staff read ----
  const zonePayload = (code, station) => ({ station, code, name: `${TAG} zone ${code}`, polygon: [], center_lat: 2.74, center_lng: 101.69 });
  const zi = await om.from("duty_zones").insert(zonePayload(`Z${runId.slice(-6).toUpperCase()}`, "KUL - MAA")).select("id").single();
  if (zi.data?.id) { ledger.zones.push(zi.data.id); save(); }
  ok("Operation Manager creates a duty zone", !zi.error && !!zi.data?.id, zi.error?.message?.slice(0, 70));
  const zoneId = zi.data?.id;
  const attempt = async (label, sb, station) => {
    const ins = await sb.from("duty_zones").insert(zonePayload(`X${label.length}${runId.slice(-4).toUpperCase()}`, station)).select("id");
    if (ins.data?.length) { ledger.zones.push(ins.data[0].id); save(); }
    const up = await sb.from("duty_zones").update({ name: `${TAG} hijack` }).eq("id", zoneId).select("id");
    const del = await sb.from("duty_zones").delete().eq("id", zoneId).select("id");
    return { insert: !!ins.error && !(ins.data?.length), update: !up.error ? (up.data ?? []).length === 0 : true, delete: !del.error ? (del.data ?? []).length === 0 : true };
  };
  for (const [label, sb, station] of [["DSE of the station", dse, "KUL - MAA"], ["Hub SE of the hub", hub, "PEN"], ["ordinary ASO", asoKul, "KUL - MAA"], ["Main Enforcement", me, "KUL - MAA"]]) {
    const r = await attempt(label, sb, station);
    ok(`${label}: zone create, edit and delete are all refused`, r.insert && r.update && r.delete, JSON.stringify(r));
  }
  const upOm = await om.from("duty_zones").update({ name: `${TAG} zone edited` }).eq("id", zoneId).select("id");
  ok("Operation Manager edits a duty zone", !upOm.error && (upOm.data ?? []).length === 1);
  const actOm = await om.from("duty_zones").update({ active: false }).eq("id", zoneId).select("id");
  ok("Operation Manager deactivates a duty zone", !actOm.error && (actOm.data ?? []).length === 1);
  const zones = async (sb) => ((await sb.from("duty_zones").select("id, code, name, station").eq("station", "KUL - MAA")).data ?? []);
  const soKul = await clientFor("so-kul");
  ok("ordinary staff (ASO and SO at KUL - MAA) still read the station's zones", (await zones(asoKul)).length >= 5 && (await zones(soKul)).length >= 5);
  const asoPen = await clientFor("aso");
  ok("a PEN ASO reads none of KUL - MAA's zones", (await zones(asoPen)).length === 0);

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  // ---- 3. zones UI and check-in ----
  {
    const { ctx, page } = await pageFor(browser, "operation_manager");
    const p = await go(page, "/avsec/admin/zones");
    ok("UI: Operation Manager opens the zone administration screen", p === "/avsec/admin/zones" && /Duty Zones/i.test(await bodyText(page)), p);
    await page.screenshot({ path: path.join(evDir, "zones-operation-manager.png"), fullPage: false });
    await ctx.close();
  }
  for (const label of ["dse", "hub_se", "aso-kul"]) {
    const { ctx, page } = await pageFor(browser, label);
    const p = await go(page, "/avsec/admin/zones");
    ok(`UI: ${label} is sent away from the zone administration screen`, p !== "/avsec/admin/zones", p);
    if (label === "dse") await page.screenshot({ path: path.join(evDir, "zones-dse-redirected.png") });
    await ctx.close();
  }
  {
    const { ctx, page } = await pageFor(browser, "aso-kul");
    const p = await go(page, "/avsec/duty/zones");
    const t = await bodyText(page);
    ok("UI: ordinary staff open the Duty Zones view and see the station's zones", p === "/avsec/duty/zones" && /REDQ/.test(t) && /BAY J/.test(t), p);
    await page.screenshot({ path: path.join(evDir, "zones-view-aso-light.png"), fullPage: true });
    await ctx.close();
  }
  {
    // check-in: inside zone 002 (BAY J), with the fixture roster row for KUL - MAA / ALPHA today
    const { ctx, page } = await pageFor(browser, "aso-kul", { width: 390, height: 844 }, "dark", { geolocation: { latitude: 2.74428867607854, longitude: 101.690063426833, accuracy: 10 }, permissions: ["geolocation"] });
    const p = await go(page, "/avsec/duty");
    const btn = page.getByRole("button", { name: /^\s*Check in\s*$/i }).first();
    await btn.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const visible = (await btn.count()) > 0 && await btn.isEnabled().catch(() => false);
    ok("UI: the check-in screen opens for an ordinary ASO with a roster and a zone to match", p === "/avsec/duty" && visible, p);
    await page.screenshot({ path: path.join(evDir, "checkin-aso-mobile-dark.png"), fullPage: true });
    if (visible) {
      await btn.click({ timeout: 8000 }).catch(() => {});
      let rec = [];
      for (let i = 0; i < 15; i += 1) {
        await page.waitForTimeout(1500);
        rec = await q("select id from public.duty_records where profile_id = $1 and duty_date = $2::date", [uid("aso-kul"), today]);
        if (rec.length > 0) break;
      }
      for (const r of rec) if (!ledger.duty.includes(r.id)) ledger.duty.push(r.id);
      save();
      ok("an ordinary ASO checks in inside a zone (duty record created through the app)", rec.length === 1, `${rec.length} record(s)`);
      await page.screenshot({ path: path.join(evDir, "checkin-aso-after.png"), fullPage: true });
    }
    await ctx.close();
  }

  // ---- 4. handover summary ----
  const handover = async (label, viewport, scheme, shot) => {
    const { ctx, page } = await pageFor(browser, label, viewport, scheme);
    const p = await go(page, "/avsec/duty/handover/new");
    const t = await bodyText(page);
    if (shot) await page.screenshot({ path: path.join(evDir, shot), fullPage: true });
    await ctx.close();
    return { p, t };
  };
  const hSo = await handover("so", { width: 1366, height: 900 }, "light", "handover-so-pen-light.png");
  ok("handover (SO at PEN): the authorized unfinished PEN movement is listed", hSo.p === "/avsec/duty/handover/new" && hSo.t.includes("ICMS-2026-990001") && /Catering Movement/.test(hSo.t), hSo.p);
  ok("handover (SO at PEN): the JHB movement is not listed", !hSo.t.includes("ICMS-2026-990002"));
  const hJhb = await handover("so-jhb", { width: 390, height: 844 }, "dark", "handover-so-jhb-mobile-dark.png");
  ok("handover (SO at JHB): its own movement is listed and PEN's is not", hJhb.t.includes("ICMS-2026-990002") && !hJhb.t.includes("ICMS-2026-990001"), hJhb.p);
  const hPro = await handover("profiling_aso", { width: 1366, height: 900 }, "light", "handover-profiling-pen.png");
  ok("handover (Profiling ASO at PEN, no checkpoint capability): neither movement is listed (unauthorized records excluded)", !hPro.t.includes("ICMS-2026-990001") && !hPro.t.includes("ICMS-2026-990002"), hPro.p);
  const hNoCap = await handover("aso-no-caterlink", { width: 1366, height: 900 }, "light", null);
  ok("handover (ASO at a station without CaterLink capability): no movement is listed", !hNoCap.t.includes("ICMS-2026-99000"));

  // ---- 5. Hub SE roster page: its hub only ----
  {
    const { ctx, page } = await pageFor(browser, "hub_se");
    const pen = await go(page, "/avsec/admin/roster?station=PEN");
    const penText = await bodyText(page);
    await page.screenshot({ path: path.join(evDir, "roster-hub-se-pen.png"), fullPage: false });
    const jhb = await go(page, "/avsec/admin/roster?station=JHB");
    const jhbText = await bodyText(page);
    ok("UI: Hub SE opens the roster screen for a station of its own hub (PEN)", pen === "/avsec/admin/roster" && /roster/i.test(penText), pen);
    ok("UI: for a station of another hub (JHB) Hub SE sees no officers or teams", jhb === "/avsec/admin/roster" && !/UAT aso-jhb|UAT so-jhb|UAT sso-jhb/.test(jhbText), jhb);
    await ctx.close();
  }
  {
    const { ctx, page } = await pageFor(browser, "dse");
    const p = await go(page, "/avsec/admin/roster?station=KUL%20-%20MAA");
    ok("UI: DSE opens the roster screen for its own station", p === "/avsec/admin/roster", p);
    await ctx.close();
  }
} catch (e) {
  ok("the verification ran to completion without an unexpected error", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  const unsafe = [...hosts].filter((h) => h.includes(FORBIDDEN_REF));
  ok("No network request went to the production Supabase project", unsafe.length === 0);
  ok("Browser traffic reached only the preview host and the staging Supabase project (plus static/font hosts)", [...hosts].every((h) => h.endsWith("vercel.app") || h.startsWith("ddlctzbnqewubltcavkh") || /gstatic|googleapis|vercel|openstreetmap\.org$/.test(h)), [...hosts].join(","));
  ok("No browser console or page errors (Vercel toolbar noise excluded)", browserErrors.length === 0, browserErrors.slice(0, 4).join(" | "));
  const clean = await cleanup();
  ok("every fixture created by this run was removed exactly (zero tagged remnants)", clean);
  await pg.end().catch(() => {});
  console.log(`\nEvidence directory: ${evDir}\nPASS=${passes} FAIL=${failures}`);
  process.exit(failures ? 1 : 0);
}
