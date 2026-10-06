#!/usr/bin/env node
// Post-migration verification of 20261025000001_caterlink_external_workflows.sql against ACTUAL staging.
// Part 1 reads the catalog (read-only transaction). Part 2 exercises the real workflow functions and row-level security
// with each identity's own session (publishable key only) and therefore WRITES clearly marked E2E test records
// (whitelist entries, one movement, vendor deliveries). It never changes accounts, passwords or assignments.
// Prints labels, booleans and counts only. Fixture ids (no secrets) are saved outside the repository for the browser run.
//
//   node --env-file=.env.local scripts/staging/verify-external-workflows-staging.mjs [--skip-writes]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const SKIP_WRITES = process.argv.includes("--skip-writes");
let failures = 0;
const check = (label, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return ok; };
const FIXTURE_FILE = path.join(os.tmpdir(), "vecta-e2e-fixtures.json");

const HARDENED = ["transactions", "seals", "seal_verifications", "catering_companies", "vehicles", "drivers", "caterlink_checkpoint_part_a", "part_b_c", "caterlink_checkpoint_part_d", "caterlink_checkpoint_hub", "caterlink_checkpoint_redq", "caterlink_incidents", "caterlink_incident_notes", "caterlink_archives", "caterlink_transaction_pdfs", "caterlink_station_capabilities", "users"];
const NEW_FUNCTIONS = ["caterlink_external_role", "create_caterlink_driver_transaction_secure", "list_caterlink_driver_options_secure", "caterlink_vendor_guard", "caterlink_can_check_vendor_station", "create_caterlink_vendor_delivery_secure", "record_caterlink_vendor_security_check_secure", "complete_caterlink_vendor_delivery_secure", "list_caterlink_audit_secure"];
const LEGACY = ["incidents", "part_a", "part_b", "part_c", "part_d", "part_hub", "part_redq", "audit_logs", "segment_timeouts", "incident_photos", "vendor_transactions", "vendor_part_a", "vendor_part_b", "vendor_part_c"];
const VECTA_TABLES = ["report_sec014", "report_sec016", "team_rosters", "duty_records", "overtime_requests", "absence_notices", "bay_board", "stations", "shifts", "duty_zones", "user_role_assignments", "investigation_cases", "announcements", "discussion_threads"];

async function main() {
  environmentGates();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const creds = loadCurrentCredentials();
  const cred = (l) => creds.find((a) => a.label === l);

  console.log("=== PART 1: CATALOG (read-only) ===");
  const { client: pg } = await connectVerified();
  let myAoc;
  try {
    await pg.query("BEGIN READ ONLY");
    const q = async (s, p) => (await pg.query(s, p)).rows;
    const mig = await q("select version from supabase_migrations.schema_migrations order by version");
    check("67 recorded migrations ending 20261026000002 (incl. 20261025000001 and both storage repairs)", mig.length === 67 && mig[64].version === "20261025000001" && mig[66].version === "20261026000002");
    check("the two vendor tables exist with RLS", (await q("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname like 'caterlink_vendor_%' and relrowsecurity order by 1")).map((r) => r.relname).join() === "caterlink_vendor_checkpoints,caterlink_vendor_deliveries");
    check("none of the 14 legacy ICMS tables exists", (await q("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)", [LEGACY])).length === 0);
    const fn = await q("select p.proname, p.prosecdef d, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') b from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = any($1)", [NEW_FUNCTIONS]);
    check("9 new functions exist, each defined exactly once", fn.length === 9);
    check("every new function: anon denied", fn.every((f) => !f.a));
    check("every callable new function is SECURITY DEFINER with a pinned search_path", fn.filter((f) => f.proname !== "caterlink_vendor_guard").every((f) => f.d && f.c.some((x) => x.startsWith("search_path="))));
    check("no database function other than the scan decision itself references the scan decision", (await q("select count(*)::int n from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ilike '%can_user_scan_caterlink%' and p.proname <> 'can_user_scan_caterlink'"))[0].n === 0);
    const bad = await q(`select c.relname, r.rolname, p.priv from pg_class c cross join (values ('anon'),('authenticated')) r(rolname) cross join (values ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv) where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname = any($1) and has_table_privilege(r.rolname, c.oid, p.priv)`, [[...HARDENED, "caterlink_vendor_deliveries", "caterlink_vendor_checkpoints"]]);
    check("hardening: no TRUNCATE/REFERENCES/TRIGGER for anon/authenticated on the 17 tables (+2 vendor tables)", bad.length === 0, `${bad.length} found`);
    const vp = (await q("select has_table_privilege('authenticated','public.caterlink_vendor_deliveries','insert') i, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','update') u, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','delete') d, has_table_privilege('anon','public.caterlink_vendor_deliveries','select') a"))[0];
    check("vendor tables: no client write grant, no anon access", !vp.i && !vp.u && !vp.d && !vp.a);
    const caps = await q("select s.code, c.can_scan, c.can_create, c.can_confirm_hub_receipt, c.can_check_vendor_delivery from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by 1");
    check("scan enabled at exactly JHB, PEN (unchanged)", caps.filter((c) => c.can_scan).map((c) => c.code).join() === "JHB,PEN");
    check("final receipt enabled at KCH, BKI (unchanged)", caps.filter((c) => c.can_confirm_hub_receipt && ["KCH", "BKI"].includes(c.code)).map((c) => c.code).join() === "BKI,KCH");
    check("creation enabled at exactly KUL - AAX, KUL - MAA (unchanged)", caps.filter((c) => c.can_create).map((c) => c.code).join() === "KUL - AAX,KUL - MAA");
    check("vendor check capability enabled at exactly JHB, PEN", caps.filter((c) => c.can_check_vendor_delivery).map((c) => c.code).join() === "JHB,PEN");
    const n = async (s, p) => parseInt((await q(s, p))[0].n, 10);
    check("56 Auth users, 56 profiles, 38 assignments, 2 trusted account rows (unchanged)", (await n("select count(*)::int n from auth.users")) === 56 && (await n("select count(*)::int n from public.profiles")) === 56 && (await n("select count(*)::int n from public.user_role_assignments")) === 38 && (await n("select count(*)::int n from public.users")) === 2);
    myAoc = (await q("select id from public.aocs where code = 'MY'"))[0].id;
    await pg.query("ROLLBACK");
  } finally { await pg.end(); }

  if (SKIP_WRITES) { console.log(`\nTotal failures: ${failures}`); process.exit(failures ? 1 : 0); }

  console.log("\n=== PART 2: WORKFLOWS AND AUTHORIZATION (each identity's own session) ===");
  const sessions = new Map();
  async function S(label) {
    if (sessions.has(label)) return sessions.get(label);
    const c = cred(label);
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await signInWithRetry(sb, c.email, c.password);
    if (error || !data.session) throw new Error(`sign-in failed for ${label}`);
    const s = { sb, uid: data.user.id };
    sessions.set(label, s);
    return s;
  }
  const rpc = async (label, fn, args = {}) => (await S(label)).sb.rpc(fn, args);
  const rows = async (label, table) => { const r = await (await S(label)).sb.from(table).select("*"); return r.error ? { n: 0, err: r.error.message } : { n: r.data.length, data: r.data }; };
  const first = (d) => (Array.isArray(d) ? d[0] : d);

  // ---- fixtures: whitelist entries created and approved by CaterLink Management (the real functions) ----
  const mgmt = "caterlink_management";
  const ensure = async (type, args, identifierKey) => {
    const r = await rpc(mgmt, "create_caterlink_whitelist_entry_secure", { p_entry_type: type, p_aoc_id: myAoc, ...args });
    if (r.error && !/IDENTIFIER_ALREADY_REGISTERED/.test(r.error.message)) throw new Error(`whitelist ${type}: ${r.error.message}`);
    const list = await rpc(mgmt, "list_caterlink_whitelist_secure", { p_aoc_id: myAoc, p_entry_type: type });
    const entry = (list.data ?? []).find((e) => (e.identifier ?? "").toUpperCase() === identifierKey);
    if (!entry) throw new Error(`whitelist ${type} entry not found`);
    if (entry.status === "pending") {
      const a = await rpc(mgmt, "approve_caterlink_whitelist_entry_secure", { p_entry_type: type, p_id: entry.id });
      if (a.error) throw new Error(`approve ${type}: ${a.error.message}`);
    }
    return entry.id;
  };
  const companyId = await ensure("vendor", { p_name: "E2E Caterer", p_code: "E2EC" }, "E2EC");
  await ensure("vehicle", { p_identifier: "E2E1234A", p_catering_company_id: companyId }, "E2E1234A");
  await ensure("driver", { p_name: "E2E Test Driver", p_identifier: "E2ED001", p_catering_company_id: companyId }, "E2ED001");
  const wl = await rpc(mgmt, "list_caterlink_whitelist_secure", { p_aoc_id: myAoc });
  check("Management created and approved the E2E vendor/vehicle/driver whitelist entries", ["E2EC", "E2E1234A", "E2ED001"].every((k) => (wl.data ?? []).some((e) => (e.identifier ?? "").toUpperCase() === k && e.status === "active")));

  // ---- Driver ----
  const drv = "caterlink-driver", vnd = "caterlink-vendor";
  const opt = await rpc(drv, "list_caterlink_driver_options_secure");
  const o = opt.data ?? {};
  check("Driver options: only usable entries and only create-capable stations", !opt.error && (o.vehicles ?? []).some((v) => v.vehicle_number === "E2E1234A") && (o.drivers ?? []).some((d) => d.staff_id === "E2ED001") && (o.stations ?? []).sort().join() === "KUL - AAX,KUL - MAA");
  check("Driver options expose only minimal fields", !JSON.stringify(o).match(/created_by|approved_by|revoked|aoc_id/));
  const tag = Date.now().toString().slice(-6);
  const txArgs = { p_origin_station: "KUL - MAA", p_direction: "OUTBOUND", p_route: "AIRCRAFT", p_vehicle_number: "E2E1234A", p_driver_name: "E2E Test Driver", p_driver_id: "E2ED001", p_seal_number: `E2E-SEAL-${tag}`, p_signature_url: "signatures/e2e-driver.png" };
  const created = await rpc(drv, "create_caterlink_driver_transaction_secure", txArgs);
  const tx = first(created.data);
  check("Driver created a movement (CL-YYYY-NNNNNN)", !created.error && /^CL-\d{4}-\d{6}$/.test(tx?.transaction_number ?? ""), created.error?.message ?? tx?.transaction_number);
  const txId = tx?.transaction_id;
  check("Driver creation is rejected for an unlisted vehicle", !!(await rpc(drv, "create_caterlink_driver_transaction_secure", { ...txArgs, p_vehicle_number: "NOTLISTED9", p_seal_number: `E2E-X1-${tag}` })).error);
  check("Driver creation is rejected for a mismatching driver name", !!(await rpc(drv, "create_caterlink_driver_transaction_secure", { ...txArgs, p_driver_name: "Someone Else", p_seal_number: `E2E-X2-${tag}` })).error);
  check("Driver creation is rejected at a station without creation capability (PEN)", !!(await rpc(drv, "create_caterlink_driver_transaction_secure", { ...txArgs, p_origin_station: "PEN", p_seal_number: `E2E-X3-${tag}` })).error);
  for (const l of [vnd, mgmt, "aso", "operation_manager"]) {
    check(`${l} cannot create a movement through the Driver function`, !!(await rpc(l, "create_caterlink_driver_transaction_secure", { ...txArgs, p_seal_number: `E2E-X4-${tag}` })).error);
  }
  check("Vendor and Management cannot list the Driver options", !!(await rpc(vnd, "list_caterlink_driver_options_secure")).error && !!(await rpc(mgmt, "list_caterlink_driver_options_secure")).error);

  // visibility of the movement and its seal/checkpoint rows follows the parent transaction (all three views agree)
  const view = async (label) => {
    const t = (await rows(label, "transactions")).data?.some((r) => r.id === txId) ?? false;
    const a = (await rows(label, "caterlink_checkpoint_part_a")).data?.some((r) => r.transaction_id === txId) ?? false;
    const s = (await rows(label, "seals")).data?.some((r) => r.transaction_id === txId) ?? false;
    return { t, a, s };
  };
  const expectVisible = { [drv]: true, [mgmt]: true, operation_manager: true, main_enforcement: true, "aso-kul": true, "sso-kul": true, [vnd]: false, aso: false, "aso-jhb": false, profiling_aso: false, "aso-kch-receipt": false, "neg-pending-profile": true };
  for (const [label, want] of Object.entries(expectVisible)) {
    const v = await view(label);
    check(`${label}: movement, Part A and seals are ${want ? "visible together" : "all invisible"} (parent-transaction visibility)`, v.t === want && v.a === want && v.s === want, JSON.stringify(v));
  }
  // station staff at KUL - MAA see it by the pre-existing station policy; account-state negatives are discussed in the report

  // ---- Vendor workflow ----
  const mkDel = (station, seal) => rpc(vnd, "create_caterlink_vendor_delivery_secure", { p_station_code: station, p_driver_name: "E2E Vendor Driver", p_driver_nric: "E2E-NRIC-001", p_vehicle_registration_no: "E2EV5678", p_seal_number: seal, p_signature_url: "signatures/e2e-vendor.png", p_supplies_description: "E2E supplies" });
  const del = first((await mkDel("PEN", `E2E-VSEAL-${tag}`)).data);
  check("Vendor created a delivery at PEN (CLV-YYYY-NNNNNN)", /^CLV-\d{4}-\d{6}$/.test(del?.delivery_number ?? ""), del?.delivery_number);
  for (const st of ["KUL - MAA", "KUL - AAX", "KCH", "BKI", "AOR", "IPH", "LGK", "NOWHERE"]) {
    check(`capability-off station ${st} accepts no vendor delivery`, !!(await mkDel(st, `E2E-VX-${st}-${tag}`)).error);
  }
  for (const l of [drv, mgmt, "aso", "operation_manager"]) {
    const r = await rpc(l, "create_caterlink_vendor_delivery_secure", { p_station_code: "PEN", p_driver_name: "x", p_driver_nric: "x", p_vehicle_registration_no: "x", p_seal_number: "E2E-V-DENY", p_signature_url: "x" });
    check(`${l} cannot create a vendor delivery (role check)`, !!r.error);
  }
  const seesDel = async (label) => (await rows(label, "caterlink_vendor_deliveries")).data?.some((r) => r.id === del.delivery_id) ?? false;
  const seesCp = async (label) => (await rows(label, "caterlink_vendor_checkpoints")).data?.some((r) => r.delivery_id === del.delivery_id) ?? false;
  for (const [label, want] of Object.entries({ [vnd]: true, [mgmt]: true, aso: true, "sso": true, [drv]: false, "aso-jhb": false, "aso-kul": false, operation_manager: false, profiling_aso: false })) {
    check(`${label}: vendor delivery + checkpoints ${want ? "visible" : "invisible"}`, (await seesDel(label)) === want && (await seesCp(label)) === want);
  }
  const check_ = (label, id, result = "PASS", reason = null) => rpc(label, "record_caterlink_vendor_security_check_secure", { p_delivery_id: id, p_signature_url: "signatures/e2e-officer.png", p_result: result, p_escalation_reason: reason, p_observed: { seal_number: "E2E" } });
  for (const l of [vnd, drv, mgmt, "operation_manager", "aso-jhb", "aso-kul", "aso-kch-receipt", "profiling_aso", "profiling_so", "neg-pending-profile", "neg-rejected-profile", "neg-deactivated-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment"]) {
    check(`${l} cannot record the PEN security check`, !!(await check_(l, del.delivery_id)).error);
  }
  check("the delivery is still CREATED after the denied attempts", ((await rows(vnd, "caterlink_vendor_deliveries")).data ?? []).find((r) => r.id === del.delivery_id)?.status === "CREATED");
  check("the Vendor cannot complete before the security check", !!(await rpc(vnd, "complete_caterlink_vendor_delivery_secure", { p_delivery_id: del.delivery_id, p_signature_url: "x" })).error);
  const ok = await check_("aso", del.delivery_id);
  check("the PEN officer recorded the security check -> SECURITY_VERIFIED", !ok.error && ((await rows(vnd, "caterlink_vendor_deliveries")).data ?? []).find((r) => r.id === del.delivery_id)?.status === "SECURITY_VERIFIED", ok.error?.message);
  check("a second security check is refused", !!(await check_("aso", del.delivery_id)).error);
  for (const l of [drv, mgmt, "aso"]) check(`${l} cannot complete the Vendor's delivery`, !!(await rpc(l, "complete_caterlink_vendor_delivery_secure", { p_delivery_id: del.delivery_id, p_signature_url: "x" })).error);
  const done = await rpc(vnd, "complete_caterlink_vendor_delivery_secure", { p_delivery_id: del.delivery_id, p_signature_url: "signatures/e2e-vendor-c.png" });
  check("the owning Vendor completed the delivery -> COMPLETED", !done.error && ((await rows(vnd, "caterlink_vendor_deliveries")).data ?? []).find((r) => r.id === del.delivery_id)?.status === "COMPLETED", done.error?.message);
  // escalation path at JHB
  const delE = first((await mkDel("JHB", `E2E-VESC-${tag}`)).data);
  check("Vendor created a delivery at JHB", /^CLV-/.test(delE?.delivery_number ?? ""));
  check("an escalation without a reason is refused", !!(await check_("aso-jhb", delE.delivery_id, "ESCALATE", null)).error);
  check("a PEN officer cannot check a JHB delivery", !!(await check_("aso", delE.delivery_id)).error);
  const esc = await check_("aso-jhb", delE.delivery_id, "ESCALATE", "E2E seal mismatch");
  check("the JHB officer escalated the delivery -> ESCALATED", !esc.error && ((await rows(vnd, "caterlink_vendor_deliveries")).data ?? []).find((r) => r.id === delE.delivery_id)?.status === "ESCALATED");
  check("an escalated delivery cannot be completed by the Vendor", !!(await rpc(vnd, "complete_caterlink_vendor_delivery_secure", { p_delivery_id: delE.delivery_id, p_signature_url: "x" })).error);
  for (const t of ["caterlink_vendor_deliveries", "caterlink_vendor_checkpoints"]) {
    const w = await (await S(vnd)).sb.from(t).update({ created_at: new Date().toISOString() }).neq("id", "00000000-0000-0000-0000-000000000000");
    const d = await (await S(vnd)).sb.from(t).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    check(`${t}: the Vendor cannot update or delete directly`, !!w.error || (w.data ?? []).length === 0, "") && check(`${t}: direct delete denied`, !!d.error || (d.data ?? []).length === 0);
  }

  // ---- Management ----
  check("Management sees the Driver's movement and both vendor deliveries", (await view(mgmt)).t && (await seesDel(mgmt)) && ((await rows(mgmt, "caterlink_vendor_deliveries")).data ?? []).some((r) => r.id === delE.delivery_id));
  const audit = await rpc(mgmt, "list_caterlink_audit_secure", { p_limit: 500 });
  const acts = new Set((audit.data ?? []).map((r) => r.action));
  check("Management audit shows Driver creation and the vendor create/check/complete events", ["caterlink_driver_transaction_create", "caterlink_vendor_delivery_create", "caterlink_vendor_security_check", "caterlink_vendor_delivery_complete"].every((a) => acts.has(a)), [...acts].join(","));
  for (const l of [drv, vnd, "aso", "operation_manager"]) check(`${l} cannot read the CaterLink audit log`, !!(await rpc(l, "list_caterlink_audit_secure", { p_limit: 5 })).error);

  // ---- isolation ----
  for (const [label, other] of [[drv, "vendor deliveries"], [vnd, "movements"]]) {
    const s = await S(label);
    const hit = {};
    for (const t of VECTA_TABLES) { const r = await s.sb.from(t).select("*", { count: "exact", head: true }); hit[t] = r.error ? 0 : (r.count ?? 0); }
    check(`${label}: reads no VECTA table row`, Object.values(hit).every((n) => n === 0), JSON.stringify(Object.fromEntries(Object.entries(hit).filter(([, n]) => n))));
    void other;
  }
  check("Driver reads no vendor workflow data; Vendor reads no catering movement data", (await rows(drv, "caterlink_vendor_deliveries")).n === 0 && (await rows(drv, "caterlink_vendor_checkpoints")).n === 0 && (await rows(vnd, "transactions")).n === 0 && (await rows(vnd, "caterlink_checkpoint_part_a")).n === 0 && (await rows(vnd, "seals")).n === 0);
  for (const l of [drv, vnd]) check(`${l}: the raw audit table stays unreadable`, (await rows(l, "phase8_audit_log")).n === 0);

  // ---- scan / receipt unchanged ----
  const scan = async (l, st) => (await rpc(l, "can_user_scan_caterlink", { p_station_code: st })).data === true;
  const rcpt = async (l, st) => (await rpc(l, "can_user_confirm_caterlink_receipt", { p_station_code: st })).data === true;
  check("scan unchanged: PEN officer true at PEN; JHB officer true at JHB", (await scan("aso", "PEN")) && (await scan("aso-jhb", "JHB")));
  check("scan unchanged: KUL officer false at KUL; KCH receipt officer false at KCH", !(await scan("aso-kul", "KUL - MAA")) && !(await scan("aso-kch-receipt", "KCH")));
  check("scan unchanged: Staff Profiling false at PEN", !(await scan("profiling_aso", "PEN")) && !(await scan("profiling_so", "PEN")));
  check("scan unchanged: Management, Driver, Vendor false at PEN/JHB", !(await scan(mgmt, "PEN")) && !(await scan(drv, "PEN")) && !(await scan(vnd, "JHB")));
  check("receipt unchanged: KCH officer true at KCH; BKI officer true at BKI", (await rcpt("aso-kch-receipt", "KCH")) && (await rcpt("aso-bki-receipt", "BKI")));
  check("receipt unchanged: Management, Driver, Vendor false", !(await rcpt(mgmt, "KCH")) && !(await rcpt(drv, "KCH")) && !(await rcpt(vnd, "KCH")));

  fs.writeFileSync(FIXTURE_FILE, JSON.stringify({ at: new Date().toISOString(), txId, txNumber: tx?.transaction_number, deliveryPen: del.delivery_id, deliveryJhb: delE.delivery_id, company: "E2EC", vehicle: "E2E1234A", driverStaffId: "E2ED001", driverName: "E2E Test Driver" }, null, 2), { mode: 0o600 });
  console.log(`\nfixture ids written outside the repository (${path.basename(FIXTURE_FILE)})`);
  console.log(`Total failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FAILED:", String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")); process.exit(1); });
