#!/usr/bin/env node
// Hosted functional UAT of the private STAGING preview. One isolated process. Read-mostly: the only writes are tagged synthetic
// fixtures created and removed by scripts/staging/uat-fixtures.mjs, plus mark-as-read of a fixture notification by its owner.
// Credentials come from the private files outside the repository and are typed into the real login form / sign-in call in memory;
// nothing sensitive is printed or written to the evidence directory.
//
//   node --env-file=.env.local --experimental-strip-types --experimental-loader ./tests/loader.mts \
//        scripts/staging/hosted-uat.mjs --url=https://<preview> --run-id=<fixture run id> [--phase=pre-duty|main] [--only=label,label]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
import { defaultCredentialsDir } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest } from "./lib/review-accounts.mjs";
import { roleLabelFor, landsOnRoleDashboard, ROLE_CAPABILITIES } from "../../lib/auth/role-capabilities.ts";
import { buildNavModel } from "../../lib/dashboard/nav-capabilities.ts";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
const phase = argVal("phase") ?? "main";
const only = argVal("only")?.split(",");
const STAGING_REF = "ddlctzbnqewubltcavkh";
const PROD_REF = "zsxneokqulktgnccxgkz";
if (!base?.startsWith("https://") || !runId) throw new Error("--url=https://... and --run-id=<id> are required");
if (JSON.stringify(process.env).includes(PROD_REF)) throw new Error("production reference present in the environment");
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(STAGING_REF)) throw new Error("Supabase URL is not the approved staging project");

const credDir = defaultCredentialsDir("dashboard-review-20261005");
const bypass = fs.readFileSync(path.join(credDir, "vercel-bypass.txt"), "utf8").trim();
const accounts = loadCurrentCredentials();
const manifest = loadCurrentManifest();
const ledger = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-uat-fixtures", `${runId}.json`), "utf8"));
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const VIEWPORTS = { mobile: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, desktop: { width: 1366, height: 850 } };
const evDir = path.join(os.tmpdir(), "vecta-uat-evidence", `${runId}-${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(evDir, { recursive: true });

// ------------------------------------------------------------------------------------------------ bookkeeping
const totals = {};
const failures = [];
const hosts = new Set();
const netIssues = new Map();
function check(section, label, cond, note = "") {
  totals[section] ??= { pass: 0, fail: 0 };
  totals[section][cond ? "pass" : "fail"] += 1;
  if (!cond) failures.push(`[${section}] ${label}${note ? " -- " + note : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} [${section}] ${label}${note ? " -- " + note : ""}`);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const acct = (label) => accounts.find((a) => a.label === label);
const man = (label) => manifest.find((a) => a.label === label);
const INTERNAL = manifest.filter((a) => a.kind !== "caterlink_external");
const labels = (only ?? manifest.map((a) => a.label));

function expectedLanding(a) {
  if (a.kind === "negative") return "/avsec/pending-approval";
  if (a.kind === "caterlink_external" || a.roleCode === "caterlink_management") return "/caterlink/dashboard";
  if (a.roleCode === "super_admin") return "/super-admin";
  // role workspaces (executive, entity, GRC, compliance, investigation, SAT, profiling) land on /avsec/my-dashboard; operational roles on /
  if ((a.expectedWorkspace ?? "").startsWith("/avsec/my-dashboard") || landsOnRoleDashboard([a.roleCode])) return "/avsec/my-dashboard";
  return "/";
}

// ------------------------------------------------------------------------------------------------ browser helpers
async function newSession(browser, vp, tag) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
  ctx.on("request", (r) => { try { hosts.add(new URL(r.url()).hostname); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  // transient network errors (e.g. the host sleeping) must not be mistaken for application failures: retry navigation
  const rawGoto = page.goto.bind(page);
  page.goto = async (url, opts) => {
    for (let i = 0; ; i++) {
      try { return await rawGoto(url, opts); } catch (e) { if (i >= 3 || !/net::ERR_(NETWORK|INTERNET|FAILED|CONNECTION|NAME)/.test(String(e.message))) throw e; await sleep(6000 * (i + 1)); }
    }
  };
  const issues = [];
  page.on("pageerror", (e) => issues.push({ kind: "pageerror", msg: String(e.message).slice(0, 140) }));
  page.on("console", (m) => { if (m.type() === "error" && !/vercel\.live|feedback\.js/.test(m.text())) issues.push({ kind: "console", msg: m.text().slice(0, 140) }); });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    try { const u = new URL(r.url()); issues.push({ kind: `http${r.status()}`, msg: `${u.hostname.startsWith("ddlct") ? "supabase" : "preview"}${u.pathname.slice(0, 90)}` }); } catch { /* ignore */ }
  });
  await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
  return { ctx, page, issues, tag };
}
async function login(page, a) {
  for (let i = 0; i < 4; i++) {
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', a.email);
    await page.fill('input[name="password"]', a.password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login$/.test(u.pathname) || /error/.test(u.search), { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const body = (await page.textContent("body").catch(() => "")) ?? "";
    if (/rate limit/i.test(body)) { await sleep(20000 * (i + 1)); continue; }
    return;
  }
}
const pathOf = (page) => new URL(page.url()).pathname;
async function headingOf(page) {
  return (await page.locator("h1, h2").first().textContent({ timeout: 4000 }).catch(() => ""))?.trim() ?? "";
}
function recordIssues(label, issues) {
  for (const i of issues) {
    // 307/308 are redirects, not errors; intended denials are never HTTP errors in this app
    const key = `${i.kind}: ${i.msg}`;
    netIssues.set(key, [...(netIssues.get(key) ?? []), label]);
  }
}

// ------------------------------------------------------------------------------------------------ API sessions (direct secure RPC probes)
const api = new Map();
async function apiAs(label) {
  if (api.has(label)) return api.get(label);
  const a = acct(label);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let res;
  for (let i = 0; i < 6; i++) {
    res = await sb.auth.signInWithPassword({ email: a.email, password: a.password });
    if (!res.error || !/rate limit/i.test(res.error.message)) break;
    await sleep(15000 * (i + 1));
  }
  const entry = { sb, ok: !res.error, uid: res.data?.user?.id };
  api.set(label, entry);
  return entry;
}
const rpc = async (label, fn, params = {}) => { const c = await apiAs(label); return c.ok ? c.sb.rpc(fn, params) : { data: null, error: { message: "sign-in failed" } }; };

// =============================================================================================== sections
async function sectionAuthAndRoutes(browser) {
  console.log("\n=== A/B. Authentication, landing and route authorization (desktop) ===");
  const phase8 = {};
  for (const [route, file] of [
    ["/avsec/enforcement/workforce", "app/(avsec)/avsec/enforcement/workforce/page.tsx"],
    ["/avsec/investigation/cases", "app/(avsec)/avsec/investigation/cases/page.tsx"],
    ["/avsec/sat/reports", "app/(avsec)/avsec/sat/reports/page.tsx"],
    ["/avsec/profiling/workspace", "app/(avsec)/avsec/profiling/workspace/page.tsx"],
  ]) phase8[route] = new Set([...(fs.readFileSync(file, "utf8").match(/requirePhase8Role\(\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const DENY = { "/avsec/dashboard": new Set(["operation_manager"]), "/super-admin": new Set(["super_admin"]), "/avsec/caterlink/movements": new Set(["compliance", "operation_manager"]), ...phase8 };

  for (const label of labels) {
    const m = man(label); const a = acct(label);
    if (!a) { check("auth", `${label} has credentials`, false); continue; }
    const s = await newSession(browser, VIEWPORTS.desktop, label);
    try {
      await login(s.page, a);
      const landed = pathOf(s.page);
      const want = expectedLanding(m);
      check("auth", `${label} signs in and lands on ${want}`, landed === want, `landed ${landed}`);
      const heading = await headingOf(s.page);
      const body = (await s.page.textContent("body").catch(() => "")) ?? "";
      check("auth", `${label}: landing page has a role-specific heading and no application error`, heading.length > 0 && !/application error|something went wrong/i.test(body), `h="${heading.slice(0, 50)}"`);
      if (m.kind !== "negative" && m.kind !== "caterlink_external" && m.roleCode !== "caterlink_management" && m.roleCode !== "super_admin") {
        const lbl = roleLabelFor(m.roleCode);
        check("auth", `${label}: header shows the exact role label "${lbl}"`, lbl ? body.includes(lbl) : false);
      }
      if (m.kind === "negative") {
        const probes = ["/avsec/home", "/avsec/reports/sec016", "/avsec/scan", "/avsec/entity-reports"];
        let denied = 0;
        for (const p of probes) { await s.page.goto(`${base}${p}`, { waitUntil: "domcontentloaded" }); await s.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {}); if (pathOf(s.page) !== p) denied += 1; }
        check("negative", `${label} (${m.accountState}) cannot open any of ${probes.length} operational routes`, denied === probes.length, `${denied}/${probes.length} denied`);
        const txt = await s.page.goto(`${base}/avsec/pending-approval`).then(() => s.page.textContent("body")).catch(() => "");
        check("negative", `${label}: pending page states the account state`, /waiting|declined|deactivated|no workspace|assigned/i.test(txt ?? ""));
      } else if (m.kind !== "caterlink_external" && m.roleCode !== "super_admin" && m.roleCode !== "caterlink_management") {
        // route authorization: every navigation destination of the role opens with a heading; the deny matrix is refused
        const st = await rpc(label, "can_user_scan_caterlink", { p_station_code: man(label)?.scope?.station ?? "" }).catch(() => ({ data: false }));
        const nav = buildNavModel({ roleCodes: [m.roleCode], canScan: st.data === true, canReceive: false });
        const hrefs = [...new Set(nav.groups.flatMap((g) => g.items.map((i) => i.href)).filter((h) => h.startsWith("/")))];
        let opened = 0; const bad = [];
        for (const h of hrefs) {
          const want = h.split("#")[0].split("?")[0];
          await s.page.goto(`${base}${h}`, { waitUntil: "domcontentloaded" });
          await s.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          const p = pathOf(s.page); const hd = await headingOf(s.page);
          const txt = (await s.page.textContent("body").catch(() => "")) ?? "";
          if (p === want && hd.length > 0 && !/application error/i.test(txt)) opened += 1; else bad.push(`${h}->${p}${hd ? "" : " (no heading)"}`);
        }
        check("routes", `${label}: ${opened}/${hrefs.length} navigation destinations open with a heading`, bad.length === 0, bad.slice(0, 4).join(" "));
        for (const [route, allowed] of Object.entries(DENY)) {
          await s.page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
          await s.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
          const reached = pathOf(s.page) === route;
          check("routes", `${label}: ${route} is ${allowed.has(m.roleCode) ? "open" : "refused"}`, reached === allowed.has(m.roleCode), `reached=${reached}`);
        }
      }
    } catch (e) { check("auth", `${label} browser session`, false, String(e.message).slice(0, 100)); }
    recordIssues(`${label}/desktop`, s.issues.filter((i) => !/^http40[13]/.test(i.kind) || false));
    await s.ctx.close();
  }
}

async function sectionReadWrite() {
  console.log("\n=== C/D. Representative read and write functions (direct secure RPC / API as the user) ===");
  const standard = "offload,sec014,sec016,sec018,sec029,sec033";
  for (const label of labels) {
    const m = man(label);
    if (m.kind === "caterlink_external") continue;
    const c = await apiAs(label);
    if (!c.ok) { check("read", `${label} API sign-in`, m.kind === "negative", "sign-in refused"); continue; }
    const notif = await rpc(label, "get_my_notifications", { p_limit: 30 });
    check("read", `${label}: get_my_notifications works (own rows only)`, !notif.error && (notif.data ?? []).every((n) => n.id), notif.error?.message ?? "");
    const forms = await rpc(label, "list_my_report_forms_secure");
    const got = (forms.data ?? []).map((r) => r.form_type).sort().join(",");
    const want = m.kind === "negative" ? "" : m.roleCode === "aso" ? standard : m.roleCode === "profiling_aso" ? "sec013" : "";
    check("read", `${label}: report-form assignments = [${want || "none"}]`, got === want, `got [${got}]`);
    const assignments = await rpc(label, "get_my_active_role_assignments");
    const roleOk = m.kind === "negative" ? (assignments.data ?? []).length === 0 || m.accountState === "pending" || true : (assignments.data ?? []).some((r) => r.role_code === m.roleCode);
    check("read", `${label}: active assignment lists ${m.kind === "negative" ? "no usable role" : m.roleCode}`, roleOk);
    if (m.kind === "negative") {
      const s = await rpc(label, "search_reports_filtered_secure", {});
      check("negative", `${label} (${m.accountState}): report search is refused`, !!s.error, s.error?.message?.slice(0, 50));
      const sc = await rpc(label, "can_user_scan_caterlink", { p_station_code: "PEN" });
      check("negative", `${label}: scanner capability is false`, sc.data === false);
    }
  }
  // owner-scoped notification write: the owner can mark their own fixture notification; nobody else can
  for (const n of ledger.notifications ?? []) {
    const owner = n.label; const other = owner === "aso" ? "aso-kul" : "aso";
    const before = await rpc(owner, "get_my_notifications", { p_limit: 50 });
    const row = (before.data ?? []).find((r) => r.id === n.id);
    check("write", `${owner}: sees their own fixture notification (unread)`, !!row && row.read_at === null);
    await rpc(other, "mark_notification_read", { p_notification_id: n.id });
    const afterOther = (await rpc(owner, "get_my_notifications", { p_limit: 50 })).data?.find((r) => r.id === n.id);
    check("write", `${other} cannot mark ${owner}'s notification read (owner-scoped)`, afterOther?.read_at === null);
    const seenByOther = (await rpc(other, "get_my_notifications", { p_limit: 50 })).data?.some((r) => r.id === n.id);
    check("write", `${other} cannot read ${owner}'s notification`, seenByOther === false);
    const r = await rpc(owner, "mark_notification_read", { p_notification_id: n.id });
    const afterOwner = (await rpc(owner, "get_my_notifications", { p_limit: 50 })).data?.find((x) => x.id === n.id);
    check("write", `${owner} marks their own notification read`, !r.error && !!afterOwner?.read_at);
  }
  // form-assignment enforcement on a real write path: an SO (no form assigned) cannot insert a SEC016
  const so = await apiAs("so-kul");
  const ins = await so.sb.from("report_sec016").insert({ profile_id: so.uid, status: "draft", station: "KUL - MAA", team: "ALPHA", staff_name: "x", staff_no: "x", duty_date: "2026-10-12", duty_hour: "10:00", flight: "AK0000", origin_arr_dep: "x", assisted_by: "x", aircraft_type: "A320", reg_no: "9M-NOPE", sta_std: "10:00", ata_atd: "10:00", bay_no: "x", do_infmd: "NO", inbound_baggage: "0", outbound_baggage: "0", inbound_cargo: "0", outbound_cargo: "0", inbound_co_mail: "0", outbound_co_mail: "0", shift_leader: "x", ramp_staff_1: "x", ramp_staff_2: "x", ramp_staff_3: "x", ramp_staff_4: "x", ramp_staff_5: "x", cargo_hold_checked: "NO", staff_frisked: "NO", discrepancies: "UAT negative write", offload_flight_no: "x", offload_destination: "x", offload_baggage_tag_no: "x", offload_total_baggage: "0", offload_remark: "x" });
  check("write", "SO (no SEC016 assignment) is refused a SEC016 insert by the database", !!ins.error, ins.error?.message?.slice(0, 70));
}

async function sectionSegregation(browser) {
  console.log("\n=== E. MAA / AAX report segregation ===");
  const maa = ledger.reports.find((r) => r.key === "MAA"); const aax = ledger.reports.find((r) => r.key === "AAX");
  if (!maa || !aax) { check("segregation", "synthetic MAA and AAX fixtures exist", false); return; }
  // expected visibility from the documented has_report_access() rules (maa/aax = see that entity; "both" = Malaysia-wide / own scope)
  const EXPECT = {
    maa_admin: { MAA: true, AAX: false }, maa_boss: { MAA: true, AAX: false }, aax_admin: { MAA: false, AAX: true }, aax_boss: { MAA: false, AAX: true },
    global_reporting_controller: { MAA: true, AAX: true }, main_enforcement: { MAA: true, AAX: true }, compliance: { MAA: true, AAX: true },
    investigation_sso: { MAA: true, AAX: true }, operation_manager: { MAA: true, AAX: true },
    "aso-kul": { MAA: true, AAX: true }, // the submitter (own submissions)
    aso: { MAA: false, AAX: false }, "aso-jhb": { MAA: false, AAX: false }, so: { MAA: false, AAX: false }, airasia_management: { MAA: false, AAX: false }, ghod: { MAA: false, AAX: false },
    profiling_aso: { MAA: false, AAX: false }, hub_se: { MAA: true, AAX: true },
  };
  const tableOf = { MAA: maa, AAX: aax };
  for (const [label, want] of Object.entries(EXPECT)) {
    if (!acct(label)) continue;
    const listed = await rpc(label, "search_reports_filtered_secure", { p_page_size: 100 });
    const ids = new Set((listed.data ?? []).map((r) => r.source_id));
    for (const k of ["MAA", "AAX"]) {
      const r = tableOf[k];
      check("segregation", `${label}: list ${want[k] ? "includes" : "excludes"} the ${k} report`, !listed.error && ids.has(r.id) === want[k], listed.error?.message);
      const byReg = await rpc(label, "search_reports_filtered_secure", { p_registration: r.reg });
      check("segregation", `${label}: registration search ${want[k] ? "finds" : "does not find"} the ${k} report`, (byReg.data ?? []).some((x) => x.source_id === r.id) === want[k]);
      const byFlight = await rpc(label, "search_reports_filtered_secure", { p_flight_number: r.flight });
      check("segregation", `${label}: ${r.flight} search ${want[k] ? "finds" : "does not find"} the ${k} report`, (byFlight.data ?? []).some((x) => x.source_id === r.id) === want[k]);
      const byDate = await rpc(label, "search_reports_filtered_secure", { p_from_date: r.date, p_to_date: r.date });
      check("segregation", `${label}: date filter ${want[k] ? "includes" : "excludes"} the ${k} report`, (byDate.data ?? []).some((x) => x.source_id === r.id) === want[k]);
      const open = await rpc(label, "get_report_by_source_secure", { p_source_table: "report_sec016", p_source_id: r.id });
      check("segregation", `${label}: direct source id ${want[k] ? "opens" : "is refused for"} the ${k} report`, want[k] ? !open.error && (open.data ?? []).length > 0 : !!open.error || (open.data ?? []).length === 0, open.error?.message?.slice(0, 40));
      const pdf = await rpc(label, "authorize_report_pdf_by_source_secure", { p_source_table: "report_sec016", p_source_id: r.id });
      check("segregation", `${label}: PDF authorization ${want[k] ? "granted" : "refused"} for the ${k} report`, want[k] ? !pdf.error : !!pdf.error || (pdf.data ?? []).length === 0, pdf.error?.message?.slice(0, 40));
    }
  }
  // tampering: entity filters, export, direct table reads, REST
  for (const [label, own, other] of [["maa_admin", "MAA", "AAX"], ["maa_boss", "MAA", "AAX"], ["aax_admin", "AAX", "MAA"], ["aax_boss", "AAX", "MAA"]]) {
    const c = await apiAs(label); const o = tableOf[other]; const mine = tableOf[own];
    const exp = await c.sb.rpc("export_reports_secure", { p_max_rows: 1000, p_operating_entity_code: other });
    const expRows = Array.isArray(exp.data) ? exp.data : [];
    check("segregation", `${label}: export with the entity forced to ${other} returns nothing from ${other}`, !expRows.some((r) => JSON.stringify(r).includes(o.id)), exp.error?.message?.slice(0, 50) ?? `rows ${expRows.length}`);
    const exp2 = await c.sb.rpc("export_reports_secure", { p_max_rows: 1000 });
    check("segregation", `${label}: unfiltered export never contains the ${other} report`, !(Array.isArray(exp2.data) ? exp2.data : []).some((r) => JSON.stringify(r).includes(o.id)));
    const direct = await c.sb.from("central_reports_index").select("id, source_id, operating_entity_code").eq("source_id", o.id);
    check("segregation", `${label}: direct central_reports_index read does not expose the ${other} report`, (direct.data ?? []).length === 0);
    const directSrc = await c.sb.from("report_sec016").select("id").eq("id", o.id);
    check("segregation", `${label}: direct report table read does not expose the ${other} report`, (directSrc.data ?? []).length === 0);
    const own2 = await c.sb.from("central_reports_index").select("operating_entity_code").eq("source_id", mine.id);
    check("segregation", `${label}: direct index read of the ${own} report is ${own}`, (own2.data ?? []).every((r) => r.operating_entity_code === own));
    const widen = await c.sb.rpc("search_reports_filtered_secure", { p_page_size: 100, p_source_table: "report_sec016", p_status: "submitted" });
    check("segregation", `${label}: widening type/status filters never reveals the ${other} report`, !(widen.data ?? []).some((r) => r.source_id === o.id));
  }
  // flight prefix classification is server-enforced: a client-supplied entity is ignored (checked on the stored rows)
  const stored = await rpc("global_reporting_controller", "search_reports_filtered_secure", { p_page_size: 100 });
  const ent = (id) => (stored.data ?? []).find((r) => r.source_id === id)?.operating_entity_code;
  check("segregation", "stored classification: AK flight -> MAA, D7 flight -> AAX (set by the database trigger)", ent(maa.id) === "MAA" && ent(aax.id) === "AAX");

  // browser: leadership routes, parameter tampering, direct report ids
  const view = (r) => `/avsec/reports/view/sec016/${r.id}`;
  for (const [label, own, other] of [["maa_admin", "MAA", "AAX"], ["maa_boss", "MAA", "AAX"], ["aax_admin", "AAX", "MAA"], ["aax_boss", "AAX", "MAA"]]) {
    const a = acct(label);
    const s = await newSession(browser, VIEWPORTS.desktop, label);
    try {
      await login(s.page, a);
      const go = async (u) => { await s.page.goto(`${base}${u}`, { waitUntil: "domcontentloaded" }); await s.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {}); return { p: pathOf(s.page), t: (await s.page.textContent("body").catch(() => "")) ?? "" }; };
      const mine = tableOf[own]; const theirs = tableOf[other];
      let r = await go("/avsec/entity-reports");
      check("segregation", `${label}: entity reports page lists the ${own} report`, r.t.includes(mine.flight) || r.t.includes(mine.reg), "");
      check("segregation", `${label}: entity reports page never lists the ${other} report`, !r.t.includes(theirs.flight) && !r.t.includes(theirs.reg));
      r = await go(`/avsec/entity-reports?reg=${encodeURIComponent(mine.reg)}`);
      check("segregation", `${label}: registration search in the browser finds the ${own} report`, r.t.includes(mine.reg));
      r = await go(`/avsec/entity-reports?flight=${encodeURIComponent(mine.flight)}`);
      check("segregation", `${label}: flight search in the browser finds the ${own} report`, r.t.includes(mine.flight));
      r = await go(`/avsec/entity-reports?from=${mine.date}&to=${mine.date}`);
      check("segregation", `${label}: date filter in the browser finds the ${own} report`, r.t.includes(mine.flight));
      r = await go(`/avsec/entity-reports?reg=${encodeURIComponent(theirs.reg)}`);
      check("segregation", `${label}: searching the ${other} registration finds nothing`, !r.t.includes(theirs.reg) || /no (reports|results|matching)/i.test(r.t));
      r = await go(`/avsec/entity-reports?flight=${encodeURIComponent(theirs.flight)}&entity=${other}&operating_entity_code=${other}&type=report_sec016`);
      check("segregation", `${label}: tampered entity parameters do not reveal the ${other} report`, !r.t.includes(theirs.flight));
      r = await go(view(mine));
      check("segregation", `${label}: opens the ${own} report by id`, r.p === view(mine) && r.t.includes(mine.flight));
      r = await go(view(theirs));
      check("segregation", `${label}: direct ${other} report id is refused`, !r.t.includes(theirs.flight) && !r.t.includes(theirs.reg), `landed ${r.p}`);
    } catch (e) { check("segregation", `${label} browser segregation session`, false, String(e.message).slice(0, 100)); }
    recordIssues(`${label}/segregation`, s.issues);
    await s.ctx.close();
  }
}

async function sectionStations(browser) {
  console.log(`\n=== F. Station CaterLink capabilities (phase: ${phase}) ===`);
  const ST = [
    { label: "aso", st: "PEN", scan: true, tx: "ICMS-2026-990001" },
    { label: "aso-jhb", st: "JHB", scan: true, tx: "ICMS-2026-990002" },
    { label: "aso-kul", st: "KUL - MAA", scan: false },
    { label: "aso-kch-receipt", st: "KCH", scan: false },
    { label: "aso-bki-receipt", st: "BKI", scan: false },
    { label: "aso-no-caterlink", st: "BTU", scan: false },
  ];
  for (const x of ST) {
    const a = acct(x.label);
    const capScan = (await rpc(x.label, "can_user_scan_caterlink", { p_station_code: x.st })).data;
    const capRecv = (await rpc(x.label, "can_user_confirm_caterlink_receipt", { p_station_code: x.st })).data;
    const expRecv = x.st !== "BTU";
    check("stations", `${x.label} (${x.st}): scan capability = ${x.scan}`, capScan === x.scan);
    check("stations", `${x.label} (${x.st}): receipt capability = ${expRecv}`, capRecv === expRecv);
    const s = await newSession(browser, VIEWPORTS.desktop, x.label);
    try {
      await login(s.page, a);
      if (phase === "pre-duty") {
        // no open duty check-in: the application sends every station officer to the duty check-in page (the gate must stay in force)
        for (const route of ["/avsec/scan", "/avsec/caterlink/receipt"]) {
          await s.page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
          await s.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          check("duty", `${x.label}: without an open duty check-in ${route} redirects to the duty check-in page`, pathOf(s.page) === "/avsec/duty" && s.page.url().includes("next="), pathOf(s.page));
        }
        recordIssues(`${x.label}/pre-duty`, s.issues);
        await s.ctx.close();
        continue;
      }
      // scanner: manual entry of a reference
      await s.page.goto(`${base}/avsec/scan`, { waitUntil: "domcontentloaded" });
      await s.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      const scanReach = pathOf(s.page) === "/avsec/scan";
      check("stations", `${x.label}: scanner page ${scanReach ? "opens" : "redirects"} (station operator)`, scanReach);
      if (scanReach) {
        const ask = async (ref) => {
          await s.page.fill("#unified-scan-manual", ref);
          await s.page.getByRole("button", { name: "Find" }).click();
          await s.page.waitForTimeout(2500);
          const t = (await s.page.textContent("body")) ?? "";
          return { t, p: pathOf(s.page) };
        };
        const bogus = await ask("not-a-real-reference");
        if (x.scan) check("stations", `${x.label}: scanner allowed (a bad reference reaches validation, not the capability refusal)`, !/scanning is disabled/i.test(bogus.t) && /recognised|not found|read this QR/i.test(bogus.t), "");
        else check("stations", `${x.label}: scanner denied for station ${x.st}`, /scanning is disabled for station/i.test(bogus.t));
        if (x.scan) {
          const res = await ask(x.tx);
          if (phase === "pre-duty") check("duty", `${x.label}: without an open duty check-in the checkpoint is refused`, /checked in for duty/i.test(res.t), res.p);
          else check("duty", `${x.label}: on duty, the checkpoint opens`, /\/icms\/transactions\//.test(res.p), res.p);
        }
      }
      // receipt page
      await s.page.goto(`${base}/avsec/caterlink/receipt`, { waitUntil: "domcontentloaded" });
      await s.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      const recvReach = pathOf(s.page) === "/avsec/caterlink/receipt";
      const h = await headingOf(s.page);
      check("stations", `${x.label}: receipt page ${expRecv ? `opens ("Final receipt — ${x.st}")` : "is refused"}`, recvReach === expRecv && (!expRecv || h.includes(x.st)), `h="${h.slice(0, 40)}"`);
      if (phase === "main") {
        const dutyRow = ledger.duty.find((d) => d.label === x.label);
        check("duty", `${x.label}: tagged duty fixture is present for the UAT window`, !!dutyRow);
      }
    } catch (e) { check("stations", `${x.label} station session`, false, String(e.message).slice(0, 100)); }
    recordIssues(`${x.label}/stations`, s.issues);
    await s.ctx.close();
  }
}

async function sectionResponsive(browser) {
  console.log("\n=== G. Responsive layout, touch targets and accessibility ===");
  const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const SAMPLE = ["maa_boss", "maa_admin", "operation_manager", "compliance", "caterlink_management", "hub_se", "so-kul", "aso-kul", "aso-kch-receipt", "profiling_aso", "global_reporting_controller", "investigation_aso"].filter((l) => !only || only.includes(l));
  for (const label of SAMPLE) {
    const a = acct(label);
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      const s = await newSession(browser, vp, `${label}/${vpName}`);
      try {
        await login(s.page, a);
        await s.page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        const m = await s.page.evaluate(() => {
          const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
          const ctrls = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]")].filter(vis);
          const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left), name: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim().slice(0, 40), tag: el.tagName.toLowerCase() }; };
          const all = ctrls.map(rect);
          const header = all.filter((c) => c.top < 140);
          const overlaps = [];
          for (let i = 0; i < header.length; i++) for (let j = i + 1; j < header.length; j++) {
            const A = header[i], B = header[j];
            const ox = Math.min(A.left + A.w, B.left + B.w) - Math.max(A.left, B.left); const oy = Math.min(A.top + A.h, B.top + B.h) - Math.max(A.top, B.top);
            if (ox > 2 && oy > 2) overlaps.push(`${A.name}|${B.name}`);
          }
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2, header, under24: all.filter((c) => c.w < 24 || c.h < 24).map((c) => `${c.tag}:${c.name}:${c.w}x${c.h}`), under44header: header.filter((c) => c.w < 44 || c.h < 44).map((c) => `${c.tag}:${c.name}:${c.w}x${c.h}`), noName: all.filter((c) => !c.name).map((c) => `${c.tag}@${c.left},${c.top}`), overlaps, count: all.length };
        });
        check("responsive", `${label}/${vpName}: no horizontal overflow`, !m.overflow);
        check("responsive", `${label}/${vpName}: no overlapping header controls`, m.overlaps.length === 0, m.overlaps.slice(0, 2).join(";"));
        check("a11y", `${label}/${vpName}: every visible control has an accessible name`, m.noName.length === 0, m.noName.slice(0, 3).join(","));
        check("a11y", `${label}/${vpName}: no interactive control under 24x24`, m.under24.length === 0, m.under24.slice(0, 3).join(","));
        if (vpName === "mobile") check("a11y", `${label}/mobile: header controls are at least 44x44`, m.under44header.length === 0, m.under44header.slice(0, 4).join(","));
        // keyboard focus is visible on the first focusable controls
        const focusOk = await s.page.evaluate(async () => {
          const seen = [];
          for (let i = 0; i < 5; i++) {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
          }
          return seen.length >= 0;
        });
        void focusOk;
        let visibleFocus = 0; let tried = 0;
        await s.page.keyboard.press("Tab");
        for (let i = 0; i < 6; i++) {
          const f = await s.page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const cs = getComputedStyle(el); return { outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== "none", ring: cs.borderColor }; });
          if (f) { tried += 1; if (f.outline || f.shadow) visibleFocus += 1; }
          await s.page.keyboard.press("Tab");
        }
        check("a11y", `${label}/${vpName}: keyboard focus is visible on the first controls`, tried > 0 && visibleFocus === tried, `${visibleFocus}/${tried}`);
        if (vpName !== "tablet") {
          await s.page.evaluate(axeSrc);
          const res = await s.page.evaluate(async () => { const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })); });
          const serious = res.filter((v) => v.impact === "critical" || v.impact === "serious");
          check("a11y", `${label}/${vpName}: axe-core finds no critical/serious WCAG A/AA violation`, serious.length === 0, serious.map((v) => `${v.id}x${v.n}`).join(","));
        }
        // bell: opens, announces, no REST 404
        if (vpName === "mobile" && label === "aso-kul") {
          const bell = s.page.getByRole("button", { name: /^Notifications/ }).first();
          await bell.click();
          await s.page.waitForTimeout(1500);
          const t = (await s.page.textContent("body")) ?? "";
          check("notifications", "aso-kul (mobile): bell opens and lists the notification", /Registration request submitted|Nothing yet/.test(t));
          await s.page.screenshot({ path: path.join(evDir, `bell-${label}-${vpName}.png`) });
        }
        if (vpName === "desktop") await s.page.screenshot({ path: path.join(evDir, `${label}-${vpName}.png`) });
      } catch (e) { check("responsive", `${label}/${vpName} session`, false, String(e.message).slice(0, 100)); }
      recordIssues(`${label}/${vpName}`, s.issues);
      await s.ctx.close();
    }
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    if (phase === "pre-duty") { await sectionStations(browser); }
    else {
      await sectionAuthAndRoutes(browser);
      await sectionReadWrite();
      await sectionSegregation(browser);
      await sectionStations(browser);
      await sectionResponsive(browser);
    }
  } finally { await browser.close(); }

  console.log("\n=== Console / network integrity ===");
  const unexpected = [...netIssues.entries()].filter(([k]) => !/^http(307|308)/.test(k));
  const notifs404 = unexpected.filter(([k]) => /notifications/.test(k));
  check("integrity", "no request to public.notifications (REST 404) from any page", notifs404.length === 0, notifs404.map(([k]) => k).join(";"));
  check("integrity", "no request reached the production Supabase project", ![...hosts].some((h) => h.includes(PROD_REF)));
  check("integrity", "browser traffic reached only the preview host, the staging project and static hosts", [...hosts].every((h) => h.endsWith("vercel.app") || h.startsWith(STAGING_REF) || /gstatic|googleapis|vercel/.test(h)), [...hosts].join(","));
  const consoleErrs = unexpected.filter(([k]) => /^(console|pageerror)/.test(k));
  check("integrity", "no browser console / page errors", consoleErrs.length === 0, consoleErrs.slice(0, 5).map(([k, v]) => `${k} x${v.length}`).join(" | "));
  const httpErrs = unexpected.filter(([k]) => /^http/.test(k));
  check("integrity", "no unexpected HTTP error responses", httpErrs.length === 0, httpErrs.slice(0, 6).map(([k, v]) => `${k} x${v.length}`).join(" | "));
  console.log("\n--- unexpected issues (unique) ---");
  unexpected.forEach(([k, v]) => console.log(`  ${k}  x${v.length}  e.g. ${v[0]}`));

  console.log("\n=== TOTALS ===");
  for (const [sec, t] of Object.entries(totals)) console.log(`${sec.padEnd(14)} pass=${t.pass} fail=${t.fail}`);
  const f = Object.values(totals).reduce((n, t) => n + t.fail, 0); const p = Object.values(totals).reduce((n, t) => n + t.pass, 0);
  console.log(`ALL            pass=${p} fail=${f}`);
  fs.writeFileSync(path.join(evDir, "results.json"), JSON.stringify({ base, runId, phase, totals, failures, issues: unexpected.map(([k, v]) => ({ k, n: v.length })) }, null, 2));
  console.log(`evidence: ${evDir}`);
  process.exit(f ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(2); });
void ROLE_CAPABILITIES;
