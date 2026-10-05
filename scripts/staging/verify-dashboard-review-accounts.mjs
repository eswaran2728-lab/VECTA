#!/usr/bin/env node
// Post-provisioning verification for one run: read-only database checks plus one REAL sign-in per account
// using the publishable key (never the secret key). Prints labels, booleans and counts only -- never
// passwords, sessions, tokens or personal data. Writes a private report next to the credentials file.
//
// Usage: node --env-file=.env.local scripts/staging/verify-dashboard-review-accounts.mjs --run-id=<id> [--expect-total-auth=52]
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, connectVerified, defaultCredentialsDir } from "./lib/run-gates.mjs";
import { COMPAT_ROLE_BY_CANONICAL } from "../../lib/auth/compat-role-map.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const runId = argVal("run-id");
const expectTotalAuth = parseInt(argVal("expect-total-auth") ?? "52", 10);
const dir = runId ? defaultCredentialsDir(runId) : null;

let failures = 0;
const results = [];
function check(label, ok, note = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`);
  return ok;
}

// Mirrors lib/avsec/auth.ts landingPathForAccess + requireProfile (no assignment / not approved -> pending-approval).
function landing(profileStatus, assignments) {
  if (profileStatus !== "approved" || assignments.length === 0) return "/avsec/pending-approval";
  const codes = assignments.map((a) => a.role_code);
  if (codes.includes("super_admin")) return "/super-admin";
  const compat = codes.map((c) => COMPAT_ROLE_BY_CANONICAL[c]).filter(Boolean);
  const rank = { ASO: 1, SO: 2, DSE: 3, ENFORCEMENT: 4, MANAGEMENT: 5 };
  const primary = compat.sort((a, b) => rank[b] - rank[a])[0];
  if (primary) return primary === "ASO" ? "/avsec/home" : "/avsec/dashboard";
  return "/avsec/my-dashboard";
}

async function main() {
  if (!runId) throw new Error("--run-id is required");
  environmentGates();
  const credPath = path.join(dir, `credentials-${runId}.json`);
  const manifestPath = path.join(dir, `manifest-${runId}.json`);
  const creds = JSON.parse(fs.readFileSync(credPath, "utf8")).accounts;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")).accounts;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anon) throw new Error("Publishable key not configured");

  // ---------------- database verification (read-only) ----------------
  console.log("\n=== DATABASE VERIFICATION ===");
  const { client: pg } = await connectVerified();
  const dbRows = {};
  let capability = {};
  try {
    await pg.query("BEGIN READ ONLY");
    const n = async (sql, p) => parseInt((await pg.query(sql, p)).rows[0].n, 10);
    const prefix = `vecta.uat.${runId}.%`;
    check(`Auth users total = ${expectTotalAuth}`, (await n("select count(*)::int n from auth.users")) === expectTotalAuth);
    check(`Profiles total = ${expectTotalAuth}`, (await n("select count(*)::int n from public.profiles")) === expectTotalAuth);
    check("Exactly 36 Auth users carry this run (email prefix AND metadata)", (await n("select count(*)::int n from auth.users where email like $1 and raw_user_meta_data->>'vecta_staging_run_id' = $2", [prefix, runId])) === 36);
    check("Exactly 36 profiles belong to this run", (await n("select count(*)::int n from public.profiles p join auth.users u on u.id = p.id where u.email like $1", [prefix])) === 36);
    check("No duplicate email among Auth users", (await n("select count(*)::int n from (select lower(email) e from auth.users group by 1 having count(*) > 1) d")) === 0);
    check("16 original Auth users unchanged in count", (await n("select count(*)::int n from auth.users where email not like 'vecta.uat.%'")) === 16);
    check("16 org_teams, 7 Storage buckets", (await n("select count(*)::int n from public.org_teams")) === 16 && (await n("select count(*)::int n from storage.buckets")) === 7);
    const hasOpsGroup = (await n("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='ops_group'")) > 0;
    check(hasOpsGroup ? "Run accounts keep ops_group NULL (no authority metadata)" : "profiles.ops_group column is absent on staging (no authority metadata possible)",
      !hasOpsGroup || (await n("select count(*)::int n from public.profiles p join auth.users u on u.id = p.id where u.email like $1 and p.ops_group is not null", [prefix])) === 0);
    check("No IFC role/assignment exists", (await n("select count(*)::int n from public.role_definitions where code ilike '%ifc%'")) === 0 && (await n("select count(*)::int n from public.user_role_assignments ura join public.role_definitions rd on rd.id = ura.role_definition_id where rd.code ilike '%ifc%'")) === 0);
    check("No run profile uses an IFC compatibility value", !hasOpsGroup || (await n("select count(*)::int n from public.profiles where coalesce(ops_group,'') ilike '%ifc%'")) === 0);

    const rows = (await pg.query(`
      select u.email, p.id profile_id, p.status::text status, rd.code role_code, ura.id assignment_id, ura.entity_membership_id,
             ura.aoc_id, ura.operating_entity_id, ura.department_id, ura.unit_id, ura.hub_id, ura.station_id, ura.team_id,
             ura.starts_at, ura.ends_at, ura.revoked_at, rd.is_active,
             a.code aoc, oe.code entity, d.code dept, un.code unit, h.code hub, s.code station, t.name team,
             m.status mstatus, m.is_primary mprimary, moe.code mentity
      from auth.users u join public.profiles p on p.id = u.id
      left join public.user_role_assignments ura on ura.profile_id = p.id
      left join public.role_definitions rd on rd.id = ura.role_definition_id
      left join public.aocs a on a.id = ura.aoc_id left join public.operating_entities oe on oe.id = ura.operating_entity_id
      left join public.departments d on d.id = ura.department_id left join public.units un on un.id = ura.unit_id
      left join public.hubs h on h.id = ura.hub_id left join public.org_stations s on s.id = ura.station_id
      left join public.org_teams t on t.id = ura.team_id
      left join public.user_entity_memberships m on m.id = ura.entity_membership_id
      left join public.operating_entities moe on moe.id = m.operating_entity_id
      where u.email like $1`, [prefix])).rows;
    for (const r of rows) (dbRows[r.email] ??= []).push(r);

    check("Exactly one assignment per account (36)", Object.keys(dbRows).length === 36 && Object.values(dbRows).every((v) => v.length === 1));
    const dupMem = await n("select count(*)::int n from (select profile_id from public.user_entity_memberships m join auth.users u on u.id = m.profile_id where u.email like $1 and is_primary and status='active' group by 1 having count(*) > 1) d", [prefix]);
    check("No duplicate primary membership", dupMem === 0);
    const catByKind = { base: 0, station_variant: 0, negative: 0 };
    let positive = 0, negative = 0;
    for (const m of manifest) { catByKind[m.kind] += 1; if (m.kind === "negative") negative += 1; else positive += 1; }
    check("Category totals 23 base / 7 variants / 6 negative; 30 positive / 6 negative", catByKind.base === 23 && catByKind.station_variant === 7 && catByKind.negative === 6 && positive === 30 && negative === 6);

    const PROTECTED = new Set(["airasia_management", "ghod", "global_reporting_controller", "super_admin", "maa_boss", "maa_admin", "aax_boss", "aax_admin", "operation_manager", "main_enforcement", "compliance", "caterlink_management"]);
    const GLOBAL = new Set(["airasia_management", "ghod", "global_reporting_controller", "super_admin"]);
    let scopeOk = true, memOk = true, entityOk = true, roleOk = true;
    const now = Date.now();
    for (const m of manifest) {
      const r = dbRows[m.email]?.[0];
      if (!r) { scopeOk = false; continue; }
      const sc = m.scope;
      if (r.role_code !== m.roleCode) roleOk = false;
      if (GLOBAL.has(m.roleCode) && [r.aoc_id, r.operating_entity_id, r.department_id, r.unit_id, r.hub_id, r.station_id, r.team_id].some(Boolean)) scopeOk = false;
      if (!GLOBAL.has(m.roleCode)) {
        if ((r.aoc ?? null) !== (sc.aoc ?? null) || (r.dept ?? null) !== (sc.department ?? null) || (r.unit ?? null) !== (sc.unit ?? null) || (r.hub ?? null) !== (sc.hub ?? null) || (r.station ?? null) !== (sc.station ?? null) || (r.team ?? null) !== (sc.team ?? null) || (r.entity ?? null) !== (sc.entity ?? null)) scopeOk = false;
      }
      if (PROTECTED.has(m.roleCode) ? r.entity_membership_id !== null : (r.entity_membership_id === null || r.mstatus !== "active" || r.mentity !== (sc.membership ?? "MAA"))) memOk = false;
      if (["maa_boss", "maa_admin"].includes(m.roleCode) && r.entity !== "MAA") entityOk = false;
      if (["aax_boss", "aax_admin"].includes(m.roleCode) && r.entity !== "AAX") entityOk = false;
    }
    check("Every assignment role matches the plan", roleOk);
    check("Scope columns match the plan exactly (global roles have all operational scope NULL; station roles never wider)", scopeOk);
    check("Membership linkage correct (protected: NULL; ordinary: active MAA membership)", memOk);
    check("MAA / AAX entity accounts resolve to the correct entity", entityOk);
    const stateOk = manifest.every((m) => {
      const r = dbRows[m.email][0];
      const expectStatus = { pending: "pending", rejected: "rejected", deactivated: "deactivated" }[m.accountState] ?? "approved";
      if (r.status !== expectStatus) return false;
      if (m.accountState === "revoked") return r.revoked_at !== null;
      if (m.accountState === "expired") return r.ends_at && new Date(r.ends_at).getTime() < now;
      if (m.accountState === "future_dated") return new Date(r.starts_at).getTime() > now;
      return r.revoked_at === null && new Date(r.starts_at).getTime() <= now && (!r.ends_at || new Date(r.ends_at).getTime() > now);
    });
    check("Account states stored as designed (status, revoked/expired/future timing)", stateOk);
    const cap = await pg.query("select s.code, c.can_scan from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where c.is_active");
    capability = Object.fromEntries(cap.rows.map((r) => [r.code, r.can_scan]));
    await pg.query("ROLLBACK");
  } finally {
    await pg.end();
  }

  // ---------------- authenticated sign-in verification ----------------
  console.log("\n=== AUTHENTICATED SIGN-IN VERIFICATION (publishable key) ===");
  const SCAN_ROLES = new Set(["aso", "so", "sso", "dse"]);
  const ROSTER_STATION_SCOPE = { PEN: "PEN" };
  for (const m of manifest) {
    const cred = creds.find((c) => c.label === m.label);
    const rec = { label: m.label, role: m.roleCode, state: m.accountState, checks: {} };
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    try {
      if (!cred || !cred.password || cred.password.startsWith("(")) throw new Error("no stored password");
      const { data: signIn, error: signErr } = await sb.auth.signInWithPassword({ email: m.email, password: cred.password });
      rec.checks.signIn = !signErr && !!signIn?.session;
      if (!rec.checks.signIn) throw new Error("sign-in failed");
      const uid = signIn.user.id;
      rec.checks.uidMatches = uid === m.authUserId;

      const { data: rows, error: rpcErr } = await sb.rpc("get_my_active_role_assignments");
      const assignments = rows ?? [];
      const { data: prof } = await sb.from("profiles").select("id, status").eq("id", uid).maybeSingle();
      rec.checks.profileReadable = !!prof;
      const expectStatus = { pending: "pending", rejected: "rejected", deactivated: "deactivated" }[m.accountState] ?? "approved";
      rec.checks.profileStatus = prof?.status === expectStatus;

      const isNegative = m.kind === "negative";
      if (isNegative) {
        // authentication succeeded; authorization must be blocked
        rec.checks.noActiveAssignment = !rpcErr && assignments.length === 0 || (["pending", "rejected", "deactivated"].includes(m.accountState) && !rpcErr && assignments.length === 0);
      } else {
        const a = assignments[0];
        rec.checks.oneActiveAssignment = !rpcErr && assignments.length === 1;
        rec.checks.roleScope = !!a && a.role_code === m.roleCode &&
          (m.scope.station ? a.station_code === m.scope.station : !a.station_code) &&
          (m.scope.team ? a.team_name === m.scope.team : !a.team_name) &&
          (m.scope.hub ? a.hub_code === m.scope.hub : !a.hub_code) &&
          (m.scope.department ? a.department_code === m.scope.department : !a.department_code) &&
          (m.scope.unit ? a.unit_code === m.scope.unit : !a.unit_code);
      }
      const landed = landing(prof?.status, assignments);
      const expectedLanding = isNegative ? "/avsec/pending-approval" : m.expectedWorkspace.split(" ")[0];
      rec.checks.landing = landed === expectedLanding;
      rec.landing = landed;

      // representative allowed / denied operation (non-destructive)
      const station = m.scope.station;
      const canManage = async (st, tm) => (await sb.rpc("can_manage_roster_secure", { p_station: st, p_team: tm })).data === true;
      if (isNegative) {
        const stations = await sb.from("stations").select("code").limit(1);
        rec.checks.deniedReferenceRead = !stations.error && (stations.data ?? []).length === 0;
        rec.checks.deniedRoster = !(await canManage("KUL - MAA", "ALPHA"));
        rec.checks.allowedOwnProfileRead = !!prof;
      } else {
        rec.checks.allowedOwnProfileRead = !!prof;
        if (m.scope.station || m.roleCode === "operation_manager") {
          const stations = await sb.from("stations").select("code").limit(1);
          rec.checks.allowedReferenceRead = !stations.error && (stations.data ?? []).length > 0;
        }
        const expectRoster = (st) => m.roleCode === "operation_manager" || (m.roleCode === "hub_se" && ["PEN"].includes(st)) || (m.roleCode === "dse" && st === "KUL - MAA");
        rec.checks.rosterPen = (await canManage("PEN", "ALPHA")) === expectRoster("PEN");
        rec.checks.rosterKul = (await canManage("KUL - MAA", "ALPHA")) === expectRoster("KUL - MAA");
        rec.checks.deniedRosterBtu = (await canManage("BTU", "ALPHA")) === (m.roleCode === "operation_manager");
        if (["investigation_sso", "investigation_so", "investigation_aso", "main_enforcement"].includes(m.roleCode)) {
          const r = await sb.rpc("list_investigation_cases_secure");
          rec.checks.allowedInvestigationList = !r.error;
        } else {
          const r = await sb.rpc("list_investigation_cases_secure");
          rec.checks.deniedInvestigationList = !!r.error;
        }
      }

      // CaterLink capability (authenticated)
      if (station) {
        const { data: scan, error: scanErr } = await sb.rpc("can_user_scan_caterlink", { p_station_code: station });
        const expected = !isNegative && SCAN_ROLES.has(m.roleCode) && capability[station] === true;
        rec.caterlink = { station, stationCanScan: capability[station] === true, scanAllowed: scan === true, expected };
        rec.checks.caterlinkScan = !scanErr && (scan === true) === expected;
      } else if (m.roleCode === "caterlink_management") {
        const [arch, inc, tx] = await Promise.all([
          sb.from("caterlink_archives").select("id").limit(1),
          sb.from("caterlink_incidents").select("id").limit(1),
          sb.from("transactions").select("id").limit(1),
        ]);
        rec.checks.caterlinkManagementReads = !arch.error && !inc.error && !tx.error;
        const { data: scan } = await sb.rpc("can_user_scan_caterlink", { p_station_code: "KUL - MAA" });
        rec.checks.caterlinkNoScan = scan !== true;
      }
    } catch (e) {
      rec.error = String(e.message).slice(0, 120);
    } finally {
      await sb.auth.signOut().catch(() => {});
    }
    const failed = Object.entries(rec.checks).filter(([, v]) => v !== true).map(([k]) => k);
    rec.ok = !rec.error && failed.length === 0;
    if (!rec.ok) failures += 1;
    results.push(rec);
    console.log(`${rec.ok ? "PASS" : "FAIL"}: ${m.label.padEnd(26)} ${String(rec.landing ?? "-").padEnd(24)} ${rec.caterlink ? `scan(${rec.caterlink.station})=${rec.caterlink.scanAllowed}` : ""}${failed.length ? " failed=" + failed.join(",") : ""}${rec.error ? " error=" + rec.error : ""}`);
  }

  const reportPath = path.join(dir, `verification-${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ runId, at: new Date().toISOString(), results }, null, 2), { mode: 0o600 });
  console.log(`\nSign-in results: ${results.filter((r) => r.ok).length}/${results.length} accounts passed`);
  console.log(`Total failures: ${failures}`);
  console.log(`Private verification report: ${reportPath}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", String(e.message).slice(0, 300)); process.exit(1); });
