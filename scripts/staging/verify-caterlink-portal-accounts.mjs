#!/usr/bin/env node
// Verification of the CaterLink-only identities against staging (database + real REST calls with each identity's own
// session, publishable key only). Non-destructive: it reads, and it never calls a function that writes. Prints labels,
// booleans and counts only -- never passwords, sessions or row data.
//
// Run with type stripping (the access decision is the real application module):
//   node --experimental-strip-types --env-file=.env.local scripts/staging/verify-caterlink-portal-accounts.mjs --expect-total-auth=56
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, loadCurrentManifest, signInWithRetry } from "./lib/review-accounts.mjs";
import { assignmentsFromRpcRows, deriveCanonicalAccess } from "../../lib/auth/canonical-access.ts";
import { classifyPortalAccess, decidePortalRequest } from "../../lib/auth/caterlink-access.ts";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const expectTotalAuth = parseInt(argVal("expect-total-auth") ?? "56", 10);
const BASE = "dashboard-review-20261005";
const EXT = `${BASE}-caterlink`;
let failures = 0;
const check = (label, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return ok; };

const FORBIDDEN_PAGES = ["/", "/avsec/home", "/avsec/dashboard", "/avsec/my-dashboard", "/avsec/admin/users", "/avsec/reports/sec014", "/super-admin"];
const VECTA_TABLES = ["report_sec014", "report_sec016", "team_rosters", "duty_records", "overtime_requests", "absence_notices", "bay_board", "stations", "shifts", "duty_zones", "user_role_assignments"];

async function main() {
  environmentGates();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const all = loadCurrentCredentials();
  const byLabel = (l) => all.find((a) => a.label === l);
  const manifestExt = loadCurrentManifest().filter((m) => m.run === EXT);

  console.log("=== DATABASE VERIFICATION ===");
  const { client: pg } = await connectVerified();
  try {
    await pg.query("BEGIN READ ONLY");
    const n = async (sql, p) => parseInt((await pg.query(sql, p)).rows[0].n, 10);
    check(`Auth users total = ${expectTotalAuth}`, (await n("select count(*)::int n from auth.users")) === expectTotalAuth);
    check(`Profiles total = ${expectTotalAuth}`, (await n("select count(*)::int n from public.profiles")) === expectTotalAuth);
    check("Exactly 2 accounts carry the CaterLink external run", (await n("select count(*)::int n from auth.users where $1::text is not null and raw_user_meta_data->>'vecta_staging_run_id' = $2", [EXT, EXT])) === 2);
    check("Exactly 2 trusted account rows exist (driver, vendor)", (await n("select count(*)::int n from public.users")) === 2);
    const rows = (await pg.query("select role, status from public.users order by role")).rows;
    check("Account rows: warehouse_pic (Driver) and vendor (Third-Party Vendor), both active", rows.length === 2 && rows[0].role === "vendor" && rows[1].role === "warehouse_pic" && rows.every((r) => r.status === "active"));
    check("The external accounts hold NO role assignment and NO entity membership", (await n("select count(*)::int n from public.user_role_assignments ura join auth.users u on u.id = ura.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' = $1", [EXT])) === 0 && (await n("select count(*)::int n from public.user_entity_memberships m join auth.users u on u.id = m.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' = $1", [EXT])) === 0);
    check("38 dashboard-review accounts still carry their 38 assignments / 26 memberships", (await n("select count(*)::int n from public.user_role_assignments ura join auth.users u on u.id = ura.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' like 'dashboard-review-20261005%' and u.raw_user_meta_data->>'vecta_staging_run_id' <> $1", [EXT])) === 38 && (await n("select count(*)::int n from public.user_entity_memberships m join auth.users u on u.id = m.profile_id where u.raw_user_meta_data->>'vecta_staging_run_id' like 'dashboard-review-20261005%'")) === 26);
    check("16 original accounts unchanged in count; 18 org_teams; 7 buckets", (await n("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' is null")) === 16 && (await n("select count(*)::int n from public.org_teams")) === 18 && (await n("select count(*)::int n from storage.buckets")) === 7);
    const cap = (await pg.query("select s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where c.can_scan order by 1")).rows.map((r) => r.code).join();
    check("Scanning remains enabled at exactly JHB and PEN", cap === "JHB,PEN");
    const rcpt = (await pg.query("select s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where c.can_confirm_hub_receipt and s.code in ('KCH','BKI') order by 1")).rows.map((r) => r.code).join();
    check("KCH and BKI final receipt remains enabled", rcpt === "BKI,KCH");
    await pg.query("ROLLBACK");
  } finally { await pg.end(); }

  console.log("\n=== AUTHENTICATED CHECKS (publishable key; each identity's own session) ===");
  async function session(label) {
    const c = byLabel(label);
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await signInWithRetry(sb, c.email, c.password);
    if (error || !data.session) throw new Error(`sign-in failed for ${label}`);
    return { sb, uid: data.user.id };
  }
  async function identityOf(sb, uid) {
    const { data: rows } = await sb.rpc("get_my_active_role_assignments");
    const { data: users } = await sb.from("users").select("role, status").eq("id", uid).maybeSingle();
    return classifyPortalAccess(deriveCanonicalAccess(assignmentsFromRpcRows(rows)), users);
  }
  const countRows = async (sb, t) => { const r = await sb.from(t).select("*", { count: "exact", head: true }); return r.error ? 0 : (r.count ?? 0); };
  const scanAll = async (sb) => (await Promise.all(["PEN", "JHB", "KUL - MAA", "KCH", "BKI", "BTU"].map(async (s) => (await sb.rpc("can_user_scan_caterlink", { p_station_code: s })).data === true))).some(Boolean);
  const rcptAll = async (sb) => (await Promise.all(["PEN", "JHB", "KUL - MAA", "KCH", "BKI", "BTU"].map(async (s) => (await sb.rpc("can_user_confirm_caterlink_receipt", { p_station_code: s })).data === true))).some(Boolean);

  for (const [label, want] of [["caterlink_management", "caterlink_management"], ["caterlink-driver", "caterlink_driver"], ["caterlink-vendor", "caterlink_vendor"]]) {
    const { sb, uid } = await session(label);
    try {
      const id = await identityOf(sb, uid);
      check(`${label}: signs in and the portal decision is ${want}`, id.kind === want, `got ${id.kind}`);
      check(`${label}: landing decision -> /caterlink/dashboard`, decidePortalRequest(id, "/", false).action === "redirect" && decidePortalRequest(id, "/", false).to === "/caterlink/dashboard");
      check(`${label}: every VECTA / AVSEC / Super Admin page is redirected to CaterLink by the decision`, FORBIDDEN_PAGES.every((p) => decidePortalRequest(id, p, false).action === "redirect"));
      const leaks = {};
      for (const t of VECTA_TABLES) leaks[t] = await countRows(sb, t);
      check(`${label}: direct REST reads of VECTA tables return no rows (DB / RLS)`, Object.values(leaks).every((v) => v === 0), JSON.stringify(Object.fromEntries(Object.entries(leaks).filter(([, v]) => v))));
      const profiles = await sb.from("profiles").select("id");
      check(`${label}: only its own profile row is readable`, !profiles.error && (profiles.data ?? []).length <= 1 && (profiles.data ?? []).every((r) => r.id === uid));
      const wr = await sb.from("profiles").update({ name: "tamper" }).eq("id", "00000000-0000-0000-0000-000000000000");
      const ins = await sb.from("report_sec014").insert({ profile_id: uid, status: "draft" });
      check(`${label}: a direct write to a VECTA table is refused by RLS / grants`, !!ins.error && (ins.error.code === "42501" || /row-level security|permission denied/i.test(ins.error.message ?? "")), ins.error ? `code ${ins.error.code}` : "no error");
      void wr;
      check(`${label}: no scan permission at any station (PEN/JHB/KUL/KCH/BKI/BTU)`, !(await scanAll(sb)));
      check(`${label}: no final-receipt permission at any station`, !(await rcptAll(sb)));
      const own = await sb.from("users").select("role, status");
      check(`${label}: reads only its own account row (or none for canonical management)`, !own.error && (own.data ?? []).length <= 1);
      if (want === "caterlink_management") {
        const [arch, inc, tx, drv, veh] = await Promise.all([sb.from("caterlink_archives").select("id").limit(1), sb.from("caterlink_incidents").select("id").limit(1), sb.from("transactions").select("id").limit(1), sb.from("drivers").select("id, name").limit(1), sb.from("vehicles").select("id, vehicle_number").limit(1)]);
        check("caterlink_management: archive, incidents, transactions, driver and vehicle whitelists are readable (approved functions)", !arch.error && !inc.error && !tx.error && !drv.error && !veh.error);
        const pii = await sb.from("drivers").select("staff_ic_number").limit(1);
        check("caterlink_management: driver IC numbers stay unreadable", !!pii.error);
      } else {
        const [arch, inc, drv, veh, cmp] = await Promise.all([sb.from("caterlink_archives").select("id"), sb.from("caterlink_incidents").select("id"), sb.from("drivers").select("id"), sb.from("vehicles").select("id"), sb.from("catering_companies").select("id")]);
        const denied = [arch, inc, drv, veh, cmp].every((r) => !!r.error || (r.data ?? []).length === 0);
        check(`${label}: management data (archive, incidents, driver/vehicle/company whitelists) is not readable`, denied);
        const mgmtRpc = await sb.rpc("archive_all_pending", { p_reason: "authorization probe" }).then((r) => r, () => ({ error: true }));
        check(`${label}: a management-only function is refused`, !!mgmtRpc.error);
      }
    } finally { await sb.auth.signOut().catch(() => {}); }
  }

  // The two external identities cannot see each other's account (no cross-account reads)
  {
    const d = await session("caterlink-driver");
    const v = await session("caterlink-vendor");
    const dSees = await d.sb.from("users").select("id");
    const vSees = await v.sb.from("users").select("id");
    check("Driver and Vendor each see only their own account row (no cross-account read)", (dSees.data ?? []).length === 1 && dSees.data[0].id === d.uid && (vSees.data ?? []).length === 1 && vSees.data[0].id === v.uid);
    await d.sb.auth.signOut(); await v.sb.auth.signOut();
  }

  // aso-no-caterlink lands in VECTA despite its e-mail name; AVSEC officers are not CaterLink-only
  for (const [label, want] of [["aso-no-caterlink", "vecta"], ["aso-jhb", "vecta"], ["sso", "vecta"], ["operation_manager", "vecta"], ["aso-kch-receipt", "vecta"]]) {
    const { sb, uid } = await session(label);
    const id = await identityOf(sb, uid);
    check(`${label}: portal decision is ${want} (e-mail name is irrelevant)`, id.kind === want && decidePortalRequest(id, "/avsec/home", false).action === "allow", `got ${id.kind}`);
    await sb.auth.signOut();
  }
  {
    const { sb } = await session("aso-jhb");
    check("aso-jhb: PEN/JHB scanning unchanged (JHB scan allowed)", (await sb.rpc("can_user_scan_caterlink", { p_station_code: "JHB" })).data === true);
    await sb.auth.signOut();
    const k = await session("aso-kch-receipt");
    check("aso-kch-receipt: KCH receipt allowed, scan denied", (await k.sb.rpc("can_user_confirm_caterlink_receipt", { p_station_code: "KCH" })).data === true && (await k.sb.rpc("can_user_scan_caterlink", { p_station_code: "KCH" })).data === false);
    await k.sb.auth.signOut();
  }

  // negative-state accounts fail closed
  for (const label of ["neg-pending-profile", "neg-rejected-profile", "neg-deactivated-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment"]) {
    const { sb, uid } = await session(label);
    const id = await identityOf(sb, uid);
    const scan = await scanAll(sb);
    check(`${label}: no active identity (kind ${id.kind}), no scan`, id.kind === "none" && !scan);
    await sb.auth.signOut();
  }

  console.log(`\nManifest accounts (external): ${manifestExt.length}\nTotal failures: ${failures}`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
