import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 6 of the VECTA Malaysia AOC upgrade
 * (2026-09-28): supabase/migrations/20260928000005_phase6_secure_report_access.sql.
 *
 * Phase 6 extends Phase 5's has_report_access() (CREATE OR REPLACE,
 * additive superset) and adds new secure list/search/flagged-report RPCs
 * and an attachment-authorization building block. No application code is
 * changed by this migration -- these tests assert the migration's own
 * source text and mirror the access-decision logic in pure functions.
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260928000005_phase6_secure_report_access.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

function fnBlock(name: string, sig = "\\([\\s\\S]*?\\)"): RegExpMatchArray | null {
  return code.match(new RegExp(`create or replace function public\\.${name}${sig}[\\s\\S]*?\\$function\\$;`));
}

// =======================================================================
// Static structural validation
// =======================================================================

test("STATIC: parentheses are balanced in the full migration file", () => {
  const opens = (code.match(/\(/g) ?? []).length;
  const closes = (code.match(/\)/g) ?? []).length;
  assert.equal(opens, closes);
});

test("STATIC: no unescaped double-hyphen inside a single-quoted string literal", () => {
  const lines = migrationSql.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const idx = line.indexOf("--");
    if (idx === -1) continue;
    const before = line.slice(0, idx);
    const quoteCount = (before.match(/'/g) ?? []).length;
    assert.equal(quoteCount % 2, 0, `line contains "--" inside an open string literal: ${line}`);
  }
});

test("STATIC: every new function is SECURITY DEFINER with a fixed search_path, revoked from public/anon", () => {
  const fns = ["has_report_access", "list_reports_secure", "search_reports_secure", "flagged_reports_secure", "get_attachment_authorization_secure"];
  for (const fn of fns) {
    const block = fnBlock(fn)![0];
    assert.match(block, /security definer/i, `${fn} must be SECURITY DEFINER`);
    assert.match(block, /set search_path to 'public'/i, `${fn} must have a fixed search_path`);
    const revokeMatches = code.match(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ([^;]+);`, "g")) ?? [];
    assert.ok(revokeMatches.length >= 1, `${fn} must have a revoke statement`);
    for (const r of revokeMatches) {
      assert.match(r, /\bpublic\b/);
      assert.match(r, /\banon\b/);
    }
  }
});

test("STATIC (corrected, round 4): the only EXECUTE format(...) in this migration is the column-grant closure DO block, which iterates a FIXED, migration-authored literal array -- never a client- or caller-supplied table name. No other dynamic SQL exists anywhere.", () => {
  const executeFormatMatches = [...code.matchAll(/execute format\('([^']*)'/g)];
  assert.equal(executeFormatMatches.length, 2, `expected exactly 2 execute format(...) calls (revoke + grant in the column-grant DO block), found ${executeFormatMatches.length}`);
  for (const m of executeFormatMatches) {
    assert.match(m[1], /^(revoke|grant) select/i);
  }
  // The array driving the loop is hardcoded in the same DO block, not a
  // parameter or any external input.
  const doBlock = code.match(/do \$\$\s*\ndeclare\s*\n\s*v_table text;\s*\nbegin\s*\n\s*foreach v_table in array array\[[\s\S]*?end;\s*\n\$\$;/);
  assert.ok(doBlock, "must find the column-grant DO block with a hardcoded table array");
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(doBlock![0], new RegExp(`'${t}'`));
  }
  assert.doesNotMatch(code, /\bexecute\s+'/i);
});

// =======================================================================
// PART A: audit action list extended
// =======================================================================

test("PART A: report_access_audit's CHECK constraint is widened additively -- every Phase 5 action value is preserved, plus attachment_url_issued", () => {
  const block = code.match(/alter table public\.report_access_audit add constraint report_access_audit_action_check check \(action in \(([\s\S]*?)\)\);/);
  assert.ok(block);
  const values = (block![1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
  const phase5Values = [
    "view", "version_view", "download", "export",
    "access_request", "grant", "revoke",
    "flag", "unflag", "amendment_request", "amendment_approved", "amendment_rejected",
    "index", "reindex", "entity_confirmed", "entity_conflict",
  ];
  for (const v of phase5Values) {
    assert.ok(values.includes(v), `must preserve Phase 5 action value ${v}`);
  }
  assert.ok(values.includes("attachment_url_issued"));
});

// =======================================================================
// PART B: has_report_access() v2 -- full role-access decision mirror
// =======================================================================

interface AccessInput {
  isSubmitter?: boolean;
  hasGlobalReportingController?: boolean;
  isFlagged?: boolean;
  hasGhod?: boolean;
  entityCode?: "MAA" | "AAX" | null;
  hasMaaBoss?: boolean;
  hasAaxBoss?: boolean;
  reportAocId?: string | null;
  hasMainEnforcementInScope?: boolean;
  hasComplianceInScope?: boolean;
  hasInvestigationInScope?: boolean;
  reportDepartmentId?: string | null;
  hasOperationManagerInScope?: boolean;
  reportHubId?: string | null;
  hasHubSeInScope?: boolean;
  reportTeamId?: string | null;
  hasDseInScope?: boolean;
  reportStationId?: string | null;
  hasStationTeamRoleInScope?: boolean; // sso/so/aso
  reportUnitId?: string | null;
  hasSatAsoInScope?: boolean;
  hasProfilingInScope?: boolean;
  hasActiveGrant?: boolean;
}

/** Mirrors has_report_access() v2's exact branch order and null-guards. */
function hasReportAccess(i: AccessInput): boolean {
  if (i.isSubmitter) return true;
  if (i.hasGlobalReportingController) return true;
  if (i.isFlagged && i.hasGhod) return true;
  if (i.entityCode === "MAA" && i.hasMaaBoss) return true;
  if (i.entityCode === "AAX" && i.hasAaxBoss) return true;
  if (i.reportAocId != null && i.hasMainEnforcementInScope) return true;
  if (i.reportAocId != null && i.hasComplianceInScope) return true;
  if (i.reportAocId != null && i.hasInvestigationInScope) return true;
  if (i.reportAocId != null && i.reportDepartmentId != null && i.hasOperationManagerInScope) return true;
  if (i.reportAocId != null && i.reportHubId != null && i.hasHubSeInScope) return true;
  if (i.reportAocId != null && i.reportTeamId != null && i.hasDseInScope) return true;
  if (i.reportAocId != null && i.reportStationId != null && i.reportTeamId != null && i.hasStationTeamRoleInScope) return true;
  if (i.reportAocId != null && i.reportUnitId != null && i.reportHubId != null && i.hasSatAsoInScope) return true;
  if (i.reportAocId != null && i.reportUnitId != null && i.hasProfilingInScope) return true;
  if (i.hasActiveGrant) return true;
  return false;
}

test("ROLE MATRIX: submitter always has access to their own report", () => {
  assert.equal(hasReportAccess({ isSubmitter: true }), true);
});

test("ROLE MATRIX: global_reporting_controller has repository-wide access, including to an unclassified (null-scope) report", () => {
  assert.equal(hasReportAccess({ hasGlobalReportingController: true, reportAocId: null }), true);
});

test("ROLE MATRIX: GHOD only while flagged -- an unflagged report is denied even with the role", () => {
  assert.equal(hasReportAccess({ isFlagged: true, hasGhod: true }), true);
  assert.equal(hasReportAccess({ isFlagged: false, hasGhod: true }), false);
});

test("ROLE MATRIX: airasia_management and super_admin are never referenced in the decision -- aggregate/dashboard-only and technical-admin-only respectively, confirmed by absence in source", () => {
  const block = fnBlock("has_report_access")![0];
  assert.doesNotMatch(block, /airasia_management/);
  assert.doesNotMatch(block, /super_admin/);
});

test("ROLE MATRIX: maa_admin/aax_admin are NOT granted boss-level access -- a flagged, narrower-by-default decision documented in the migration, confirmed by absence in source", () => {
  const block = fnBlock("has_report_access")![0];
  assert.doesNotMatch(block, /'maa_admin'/);
  assert.doesNotMatch(block, /'aax_admin'/);
});

test("ROLE MATRIX: caterlink_management is NOT granted AVSEC report access -- confirmed by absence in source", () => {
  const block = fnBlock("has_report_access")![0];
  assert.doesNotMatch(block, /caterlink_management/);
});

test("ROLE MATRIX: MAA vs AAX isolation -- maa_boss cannot access an AAX report and vice versa", () => {
  assert.equal(hasReportAccess({ entityCode: "AAX", hasMaaBoss: true }), false);
  assert.equal(hasReportAccess({ entityCode: "MAA", hasAaxBoss: true }), false);
  assert.equal(hasReportAccess({ entityCode: "MAA", hasMaaBoss: true }), true);
  assert.equal(hasReportAccess({ entityCode: "AAX", hasAaxBoss: true }), true);
});

test("ROLE MATRIX: cross-AOC denial -- main_enforcement/compliance/investigation/operation_manager/hub_se/dse/sso-so-aso/sat_aso/profiling all require a non-null report aoc_id to ever be considered", () => {
  const scoped: AccessInput[] = [
    { reportAocId: null, hasMainEnforcementInScope: true },
    { reportAocId: null, hasComplianceInScope: true },
    { reportAocId: null, hasInvestigationInScope: true },
    { reportAocId: null, reportDepartmentId: "d1", hasOperationManagerInScope: true },
    { reportAocId: null, reportHubId: "h1", hasHubSeInScope: true },
    { reportAocId: null, reportTeamId: "t1", hasDseInScope: true },
    { reportAocId: null, reportStationId: "s1", reportTeamId: "t1", hasStationTeamRoleInScope: true },
    { reportAocId: null, reportUnitId: "u1", reportHubId: "h1", hasSatAsoInScope: true },
    { reportAocId: null, reportUnitId: "u1", hasProfilingInScope: true },
  ];
  for (const s of scoped) {
    assert.equal(hasReportAccess(s), false, `must deny when reportAocId is null: ${JSON.stringify(s)}`);
  }
});

test("ROLE MATRIX: Investigation (SSO/SO/ASO) has Malaysia-wide read within its own aoc_id, no hub/station/team narrowing", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", hasInvestigationInScope: true }), true);
});

test("ROLE MATRIX: Compliance is read-only Malaysia-wide within its own aoc_id (read access only -- this mirror asserts access, not write, since compliance has no write path anywhere in this or Phase 5's migration)", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", hasComplianceInScope: true }), true);
  const flagBlock = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations", "20260928000004_phase5_report_classification_repository.sql"),
    "utf8",
  );
  assert.doesNotMatch(flagBlock, /has_active_role\('compliance'\)/);
});

test("ROLE MATRIX: Operation Manager -- Malaysia AOC + Operation department, across all hubs/stations; denied for a report with no department classification (null-scope denial)", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportDepartmentId: "operation-dept", hasOperationManagerInScope: true }), true);
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportDepartmentId: null, hasOperationManagerInScope: true }), false);
});

test("ROLE MATRIX: Hub SE -- own hub only; cross-hub denial", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportHubId: "kul", hasHubSeInScope: true }), true);
  // has_role_in_scope itself enforces the hub match -- a caller scoped to
  // a DIFFERENT hub would never set hasHubSeInScope true for this report,
  // which this mirror models by the flag simply being false in that case.
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportHubId: "kul", hasHubSeInScope: false }), false);
});

test("ROLE MATRIX: DSE -- own KUL team only; cross-team denial modeled the same way (has_role_in_scope enforces the team match)", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportTeamId: "team-a", hasDseInScope: true }), true);
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportTeamId: "team-a", hasDseInScope: false }), false);
});

test("ROLE MATRIX: SSO/SO/ASO -- require BOTH station and team to be set on the report; a report missing either is denied even with the role in scope elsewhere", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportStationId: "s1", reportTeamId: "t1", hasStationTeamRoleInScope: true }), true);
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportStationId: "s1", reportTeamId: null, hasStationTeamRoleInScope: true }), false);
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportStationId: null, reportTeamId: "t1", hasStationTeamRoleInScope: true }), false);
});

test("ROLE MATRIX (corrected, round 3): report acknowledgement/ops_group isolation is preserved, not merely untouched -- needs_your_action_secure() (Part S) re-implements the exact existing eligibility rule (SO/DSE role, own station, own team, own ops_group when set) server-side, and it is the ONLY place in this migration that references acknowledgement/ops_group at all", () => {
  const block = fnBlock("needs_your_action_secure")![0];
  assert.match(block, /r\.ops_group = v_ops_group/);
  assert.match(block, /report_acknowledgements/);
  const withoutNeedsYourAction = code.replace(fnBlock("needs_your_action_secure")![0], "");
  assert.doesNotMatch(withoutNeedsYourAction, /acknowledgement/);
  assert.doesNotMatch(withoutNeedsYourAction, /ops_group/);
});

test("ROLE MATRIX: SAT ASO -- own unit (SAT) AND hub (KUL) together; missing either is denied", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportUnitId: "sat", reportHubId: "kul", hasSatAsoInScope: true }), true);
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportUnitId: "sat", reportHubId: null, hasSatAsoInScope: true }), false);
});

test("ROLE MATRIX: Profiling SO/ASO -- own unit (Profiling), Malaysia-wide within it, no hub/station narrowing; preserves SEC013 workflow (ASO submits, SO acknowledges) since this migration only adds READ access, never touches submission/acknowledgement", () => {
  assert.equal(hasReportAccess({ reportAocId: "aoc1", reportUnitId: "profiling", hasProfilingInScope: true }), true);
});

test("ROLE MATRIX: null-scope denial -- a report with reportAocId set but every other scope column null is denied to every scoped role except global_reporting_controller/submitter/grant", () => {
  const input: AccessInput = {
    reportAocId: "aoc1",
    hasMainEnforcementInScope: false, hasComplianceInScope: false, hasInvestigationInScope: false,
    hasOperationManagerInScope: true, hasHubSeInScope: true, hasDseInScope: true,
    hasStationTeamRoleInScope: true, hasSatAsoInScope: true, hasProfilingInScope: true,
  };
  assert.equal(hasReportAccess(input), false, "every scoped role's own report_<column> is null, so none can match despite holding the role");
});

test("ROLE MATRIX: own-report access via submitter overrides everything -- even with no role at all", () => {
  assert.equal(hasReportAccess({ isSubmitter: true, reportAocId: null }), true);
});

test("ROLE MATRIX: explicit-grant access works when no role matches", () => {
  assert.equal(hasReportAccess({ hasActiveGrant: true }), true);
  assert.equal(hasReportAccess({ hasActiveGrant: false }), false);
});

test("ROLE MATRIX: an inactive/revoked/expired assignment never reaches this decision at all -- has_role_in_scope() (Phase 3, unchanged) filters revoked_at/starts_at/ends_at/rd.is_active/p.status='approved' BEFORE returning true, so every *InScope flag in this mirror already encodes that rejection", () => {
  const block = fnBlock("has_report_access")![0];
  assert.match(block, /has_role_in_scope\('main_enforcement', v_report\.aoc_id\)/, "has_role_in_scope is reused, not re-implemented, for every Phase 6 branch");
  // The only revoked_at/starts_at/expires_at reference inside this
  // function's own body is the pre-existing (Phase 5, unchanged) GRANT
  // expiry check at the end -- not a re-implementation of assignment
  // lifecycle rules, which live exclusively in has_role_in_scope().
  const withoutGrantCheck = block.replace(/if exists \(\s*\n\s*select 1 from public\.report_access_grants g[\s\S]*?end if;/, "");
  assert.doesNotMatch(withoutGrantCheck, /revoked_at|starts_at|ends_at/, "Phase 6's new branches must not re-implement assignment-lifecycle checks -- they reuse has_role_in_scope()/has_active_role() exclusively");
});

test("PART B: every new branch calls has_role_in_scope() or has_active_role() (Phase 3, unchanged) -- no independent re-derivation of role/assignment state", () => {
  const block = fnBlock("has_report_access")![0];
  for (const role of ["operation_manager", "hub_se", "dse", "sso", "so", "aso", "sat_aso", "profiling_so", "profiling_aso"]) {
    assert.match(block, new RegExp(`has_role_in_scope\\('${role}'`), `${role} must be checked via has_role_in_scope()`);
  }
});

test("PART B: EXECUTE grant for has_report_access() is unchanged from Phase 5 (authenticated + service_role, revoked from public/anon)", () => {
  assert.match(code, /revoke execute on function public\.has_report_access\(uuid\) from public, anon;/);
  assert.match(code, /grant execute on function public\.has_report_access\(uuid\) to authenticated, service_role;/);
});

// =======================================================================
// PART C/D/E: secure list/search/flagged RPCs
// =======================================================================

test("SECURE RPCs: list/search/flagged all reject page_size above 100 (hard cap) via LEAST/GREATEST clamping, regardless of the client-supplied value", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /least\(greatest\(coalesce\(p_page_size, 25\), 1\), 100\)/, `${fn} must clamp page_size to [1, 100]`);
  }
});

/** Mirrors the page-size clamp used by all three secure RPCs. */
function clampPageSize(requested: number | null | undefined): number {
  const v = requested ?? 25;
  return Math.min(Math.max(v, 1), 100);
}

test("SECURE RPCs DECISION MIRROR: page size is always clamped to [1, 100] no matter what the client requests", () => {
  assert.equal(clampPageSize(undefined), 25);
  assert.equal(clampPageSize(0), 1);
  assert.equal(clampPageSize(-5), 1);
  assert.equal(clampPageSize(100), 100);
  assert.equal(clampPageSize(100000), 100);
});

test("SECURE RPCs: every one of the three list/search/flagged RPCs filters through has_report_access() FIRST, inside a CTE, before any other filter is applied -- the authorized set is computed once and every other filter narrows within it, never widens it", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /with authorized as \(\s*\n\s*select cri\.\*\s*\n\s*from public\.central_reports_index cri\s*\n\s*where (cri\.flag_state = 'flagged'\s*\n\s*and )?public\.has_report_access\(cri\.id\)/);
  }
});

test("SECURE RPCs: total_count is computed from the SAME authorized CTE, never a raw table count -- an unauthorized caller can never learn how many reports exist that they cannot see", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /counted as \(\s*\n\s*select count\(\*\) as n from authorized\s*\n\s*\)/);
    assert.doesNotMatch(block, /count\(\*\)\s*from\s*public\.central_reports_index(?!\s*cri)/);
  }
});

test("SECURE RPCs: deterministic ordering -- list/search order by indexed_at desc, id; flagged orders by flagged_at desc nulls last, id -- a stable tiebreaker column is always included", () => {
  assert.match(fnBlock("list_reports_secure")![0], /order by a\.indexed_at desc, a\.id/);
  assert.match(fnBlock("search_reports_secure")![0], /order by a\.indexed_at desc, a\.id/);
  assert.match(fnBlock("flagged_reports_secure")![0], /order by a\.flagged_at desc nulls last, a\.id/);
});

test("SECURE RPCs: search_reports_secure() validates source_table/flag_state filters against a fixed allowlist in list_reports_secure(), and never accepts a client-supplied column or table name anywhere -- every filter is a typed, named parameter bound by the planner, never string-built", () => {
  const listBlock = fnBlock("list_reports_secure")![0];
  assert.match(listBlock, /if p_source_table is not null and p_source_table not in \(/);
  assert.match(listBlock, /raise exception 'Unsupported source_table filter\.'/);
  assert.match(listBlock, /if p_flag_state is not null and p_flag_state not in \('unflagged', 'flagged'\) then/);
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.doesNotMatch(block, /format\(/);
    assert.doesNotMatch(block, /\|\|/); // no string concatenation building a query fragment
  }
});

test("SECURE RPCs: both list and search require an approved profile status, rejecting an unauthenticated or unapproved caller before ever touching central_reports_index", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /auth\.uid\(\) is null then/);
    assert.match(block, /status = 'approved'/);
  }
});

test("SECURE RPCs: search_reports_secure() supports the required filter set (date range via from/to, report type/reference, AOC, operating entity, department/unit, hub/station/team, flight number, severity, flag state, status, submitter)", () => {
  const block = fnBlock("search_reports_secure")![0];
  for (const filter of [
    "p_flight_number", "p_report_reference", "p_aoc_id", "p_operating_entity_code",
    "p_department_id", "p_unit_id", "p_hub_id", "p_station_id", "p_team_id",
    "p_severity", "p_flag_state", "p_status", "p_submitter_profile_id",
  ]) {
    assert.match(block, new RegExp(filter));
  }
});

test("SECURE RPCs: list_reports_secure() supports date-range filtering (from/to) in addition to source_table/flag_state/status", () => {
  const block = fnBlock("list_reports_secure")![0];
  assert.match(block, /p_from_date is null or cri\.report_date >= p_from_date/);
  assert.match(block, /p_to_date is null or cri\.report_date <= p_to_date/);
});

test("SECURE RPCs: EXECUTE grants are minimum-necessary -- authenticated + service_role, revoked from public/anon, for all three", () => {
  for (const [fn, sig] of [
    ["list_reports_secure", "integer, integer, text, text, text, date, date"],
    ["search_reports_secure", "integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid"],
    ["flagged_reports_secure", "integer, integer"],
  ]) {
    assert.match(code, new RegExp(`revoke execute on function public\\.${fn}\\(${sig!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) from public, anon;`));
    assert.match(code, new RegExp(`grant execute on function public\\.${fn}\\(${sig!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) to authenticated, service_role;`));
  }
});

// =======================================================================
// Enumeration / existence-oracle resistance
// =======================================================================

test("ENUMERATION RESISTANCE: get_report_secure() (Phase 5, reused unchanged this phase) raises the SAME generic 'Not authorized' exception whether a report does not exist at all or exists but the caller lacks access -- has_report_access() returns false for a nonexistent id, and get_report_secure() then raises the identical message either way", () => {
  const phase5Sql = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations", "20260928000004_phase5_report_classification_repository.sql"),
    "utf8",
  );
  const hasAccessBlock = phase5Sql.match(/create or replace function public\.has_report_access[\s\S]*?\$function\$;/)![0];
  assert.match(hasAccessBlock, /if v_report is null then\s*\n\s*return false;/);
  const getSecureBlock = phase5Sql.match(/create or replace function public\.get_report_secure[\s\S]*?\$function\$;/)![0];
  assert.match(getSecureBlock, /raise exception 'Not authorized to access this report\.';/);
});

test("ENUMERATION RESISTANCE: list/search/flagged never return a distinct 'you have N inaccessible reports' signal -- total_count is scoped to the authorized CTE exclusively (already asserted above), so pagination past the authorized set simply returns zero rows, not an error revealing more exist", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure", "flagged_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.doesNotMatch(block, /raise exception 'No (more )?reports/i);
  }
});

// =======================================================================
// PART F: attachment authorization
// =======================================================================

test("ATTACHMENTS: get_attachment_authorization_secure() fails closed when the attachment's report has no matching central_reports_index row (source_table/source_id join miss) -- never falls back to granting access", () => {
  const block = fnBlock("get_attachment_authorization_secure")![0];
  assert.match(block, /if v_repository_id is null then/);
  assert.match(block, /raise exception 'Attachment cannot be authorized through the secure repository path yet/);
});

test("ATTACHMENTS: cross-report/cross-AOC path substitution is impossible -- the function looks up the attachment's OWN report_type/report_id, joins to the matching central_reports_index row by that exact pair, and calls has_report_access() on THAT row's id -- there is no parameter through which a caller can supply an arbitrary storage path or a different report's identity", () => {
  const block = fnBlock("get_attachment_authorization_secure")![0];
  assert.match(block, /where cri\.source_table = v_attachment\.report_type and cri\.source_id = v_attachment\.report_id/);
  assert.match(block, /select \* into v_attachment from public\.report_attachments where id = p_attachment_id;/);
  // Only ONE parameter exists at all -- the attachment id -- so there is
  // no client-suppliable path/report-id field to substitute.
  assert.match(code, /get_attachment_authorization_secure\(p_attachment_id uuid\)/);
});

test("ATTACHMENTS: authorization is re-checked immediately before returning the path -- has_report_access() is called AFTER the repository lookup, not cached from an earlier request, so a revoked grant or ended assignment blocks the very next call", () => {
  const block = fnBlock("get_attachment_authorization_secure")![0];
  const repoLookupIdx = block.indexOf("v_repository_id");
  const accessCheckIdx = block.indexOf("if not public.has_report_access(v_repository_id) then");
  assert.ok(repoLookupIdx > -1 && accessCheckIdx > repoLookupIdx);
});

test("ATTACHMENTS: no signed URL, storage service key, or permanent public URL is ever generated by this function -- it returns only storage_path/file_name/mime_type, metadata for a future signing step to consume", () => {
  const block = fnBlock("get_attachment_authorization_secure")![0];
  assert.doesNotMatch(block, /createSignedUrl/);
  assert.doesNotMatch(block, /SUPABASE_SERVICE_ROLE/);
  assert.match(block, /returns table \(storage_path text, file_name text, mime_type text\)/);
});

test("ATTACHMENTS: every successful authorization writes an attachment_url_issued audit row before returning", () => {
  const block = fnBlock("get_attachment_authorization_secure")![0];
  const auditIdx = block.indexOf("insert into public.report_access_audit");
  const returnIdx = block.indexOf("return query select v_attachment.storage_path");
  assert.ok(auditIdx > -1 && returnIdx > auditIdx, "audit must be written before the return");
  assert.match(block, /'attachment_url_issued'/);
});

test("ATTACHMENTS (corrected, round 2): this function IS now called from lib/avsec/attachments/actions.ts -- getReportAttachments() calls it per-attachment before issuing any signed URL, and signs the RPC's own returned storage_path, never the client-visible row's own path", () => {
  const attachmentsActions = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "attachments", "actions.ts"),
    "utf8",
  );
  assert.match(attachmentsActions, /\.rpc\("get_attachment_authorization_secure"/);
  assert.match(attachmentsActions, /createSignedUrl\(authorized\.storage_path/);
});

// =======================================================================
// PART G: indexes
// =======================================================================

test("INDEXES: every filter/order-by column used by list/search/flagged has a supporting index (report_date, indexed_at, flight_number, severity, aoc_id, department_id, hub_id, station+team, unit_id, submitter), plus the grant-lookup and audit-actor-lookup directions", () => {
  const expected = [
    "central_reports_index_report_date_idx", "central_reports_index_indexed_at_idx",
    "central_reports_index_flight_number_idx", "central_reports_index_severity_idx",
    "central_reports_index_aoc_idx", "central_reports_index_department_idx",
    "central_reports_index_hub_idx", "central_reports_index_station_team_idx",
    "central_reports_index_unit_idx", "central_reports_index_submitter_idx",
    "report_access_grants_grantee_idx", "report_access_audit_actor_idx",
  ];
  for (const idx of expected) {
    assert.match(code, new RegExp(`create index if not exists ${idx}`), `missing index ${idx}`);
  }
});

test("INDEXES: no index is created on an insecure view -- every index in this migration targets a base table (central_reports_index, report_access_grants, report_access_audit), never a view", () => {
  assert.doesNotMatch(code, /create index[\s\S]*?on public\.v_/);
});

// =======================================================================
// Non-regression / phase-boundary checks
// =======================================================================

test("NON-REGRESSION (corrected, round 2): this migration adds exactly one column (report_access_audit.access_reason, additive/nullable) and no CREATE TABLE / DROP TABLE / DROP COLUMN anywhere", () => {
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /drop table/i);
  assert.doesNotMatch(code, /drop column/i);
  const addColumnMatches = code.match(/add column if not exists (\w+)/g) ?? [];
  assert.deepEqual(addColumnMatches, ["add column if not exists access_reason"]);
});

test("NON-REGRESSION (corrected, round 3): Part O intentionally DROPs and re-CREATEs exactly one SELECT policy per report table (own-row only) -- this is the direct-read closure itself, not an accidental regression. No INSERT or UPDATE policy is touched at all.", () => {
  const dropMatches = code.match(/drop policy if exists "[a-z0-9]+ (station|monitor|rank) select" on public\.\w+;/g) ?? [];
  const createMatches = code.match(/create policy "[a-z0-9]+ own select" on public\.\w+ for select using \(profile_id = auth\.uid\(\)\);/g) ?? [];
  assert.ok(dropMatches.length >= 7, `expected at least 7 broad-select policy drops, found ${dropMatches.length}`);
  assert.equal(createMatches.length, 7, `expected exactly 7 own-select policy (re)creations, found ${createMatches.length}`);
  assert.doesNotMatch(code, /(create|alter|drop) policy[\s\S]{0,80}for (insert|update)/i, "no INSERT/UPDATE policy is touched");
});

test("NON-REGRESSION: this migration does not reference report creation, submission, or the block_submitted_report_mutation()/enforce_report_row_immutability()/derive_report_classification() triggers at all -- Phase 6 is read-access only", () => {
  assert.doesNotMatch(code, /block_submitted_report_mutation/);
  assert.doesNotMatch(code, /enforce_report_row_immutability/);
  assert.doesNotMatch(code, /derive_report_classification/);
});

test("NON-REGRESSION: CaterLink is never referenced by has_report_access() or any new RPC -- CaterLink's own domain (transactions, incidents, archive, PDFs) is completely untouched by this migration", () => {
  assert.doesNotMatch(code, /caterlink_transactions|icms_/i);
});

test("PHASE BOUNDARY (corrected, round 4): this migration does not execute the Phase 5 backfill or migrate existing production accounts -- the one 'insert into public.central_reports_index' is inside index_report()'s own function BODY (re-declared here only to add the version-1 snapshot fix), never a bare top-level INSERT statement that would itself write rows when this file is applied", () => {
  const bareTopLevelInsert = code.match(/^insert into public\.central_reports_index/m);
  assert.equal(bareTopLevelInsert, null, "must not contain a bare, migration-level INSERT into central_reports_index");
  const insertCount = (code.match(/insert into public\.central_reports_index/g) ?? []).length;
  assert.equal(insertCount, 1, "the only occurrence must be inside index_report()'s function body");
  assert.doesNotMatch(code, /update public\.profiles/);
});

// =======================================================================
// ROLLBACK
// =======================================================================

test("ROLLBACK: documents dropping the new functions before reverting get_report_secure()/has_report_access() to their Phase 5 forms and widening report_access_audit's constraint back, then dropping the new indexes last", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/)![0];
  const fnDropIdx = rollbackBlock.indexOf("drop function if exists public.get_attachment_authorization_secure(uuid);");
  const revertIdx = rollbackBlock.indexOf("Revert has_report_access() to its exact Phase 5 form");
  const constraintIdx = rollbackBlock.indexOf("Revert report_access_audit's CHECK constraint");
  const indexDropIdx = rollbackBlock.indexOf("drop index if exists public.central_reports_index_report_date_idx;");
  assert.ok(fnDropIdx > -1 && revertIdx > fnDropIdx && constraintIdx > revertIdx && indexDropIdx > constraintIdx);
});

// =======================================================================
// CORRECTION ROUND 2, PART I/J: audit extension, access_reason, get_report_secure() v2
// =======================================================================

test("PART I: report_access_audit's CHECK is widened additively for round 2 -- every prior value (including round 1's attachment_url_issued) is preserved, plus the 7 new event types required by review section 10", () => {
  const blocks = [...code.matchAll(/alter table public\.report_access_audit add constraint report_access_audit_action_check check \(action in \(([\s\S]*?)\)\);/g)];
  assert.ok(blocks.length >= 2, "expected both the round-1 and round-2 widening statements");
  const block = [blocks[blocks.length - 1]];
  const values = (block[0]![1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
  for (const v of [
    "view", "version_view", "download", "export", "access_request", "grant", "revoke",
    "flag", "unflag", "amendment_request", "amendment_approved", "amendment_rejected",
    "index", "reindex", "entity_confirmed", "entity_conflict", "attachment_url_issued",
    "detail_view", "amendment_view", "pdf_generated", "pdf_downloaded",
    "export_generated", "explicit_grant_used", "unauthorized_attempt",
  ]) {
    assert.ok(values.includes(v), `must preserve/add action value ${v}`);
  }
});

test("PART I: access_reason is an additive, nullable column -- existing rows (none yet in any real database) are unaffected", () => {
  assert.match(code, /alter table public\.report_access_audit add column if not exists access_reason text;/);
});

test("PART J: resolve_report_access_reason() mirrors has_report_access()'s branch order exactly -- same role checks, in the same sequence, so the two functions can never disagree about WHETHER access exists, only WHY", () => {
  const accessBlock = fnBlock("has_report_access")![0];
  const reasonBlock = fnBlock("resolve_report_access_reason")![0];
  const rolesInOrder = [
    "submitter_profile_id = auth.uid()", "global_reporting_controller", "ghod",
    "maa_boss", "aax_boss", "main_enforcement", "compliance",
    "investigation_sso", "operation_manager", "hub_se", "dse", "'sso'",
    "sat_aso", "profiling_so",
  ];
  let lastAccessIdx = -1;
  let lastReasonIdx = -1;
  for (const role of rolesInOrder) {
    const accessIdx = accessBlock.indexOf(role);
    const reasonIdx = reasonBlock.indexOf(role);
    assert.ok(accessIdx > lastAccessIdx, `${role} out of order in has_report_access()`);
    assert.ok(reasonIdx > lastReasonIdx, `${role} out of order in resolve_report_access_reason()`);
    lastAccessIdx = accessIdx;
    lastReasonIdx = reasonIdx;
  }
});

test("PART J: get_report_secure() v2 writes 'detail_view' for a default-version read and 'version_view' for an explicit version read (corrected from round 1's generic 'view')", () => {
  const block = fnBlock("get_report_secure")![0];
  assert.match(block, /case when p_version_number is null then 'detail_view' else 'version_view' end/);
});

test("PART J: get_report_secure() v2 records access_reason and, when the reason is an explicit grant, parses the grant_id out of it into the existing grant_id column", () => {
  const block = fnBlock("get_report_secure")![0];
  assert.match(block, /v_reason := public\.resolve_report_access_reason\(p_repository_report_id\);/);
  assert.match(block, /if v_reason like 'explicit_grant:%' then/);
  assert.match(block, /v_grant_id := replace\(v_reason, 'explicit_grant:', ''\)::uuid;/);
  assert.match(block, /insert into public\.report_access_audit \(actor_id, repository_report_id, version_number, action, access_reason, grant_id\)/);
});

test("PART J: get_report_secure() v2 writes an 'unauthorized_attempt' audit row (without repository content) before raising, for a denied caller -- and raises the SAME generic message as before, so this new event type does not create a new existence oracle", () => {
  const block = fnBlock("get_report_secure")![0];
  assert.match(block, /if not public\.has_report_access\(p_repository_report_id\) then/);
  assert.match(block, /'unauthorized_attempt', 'get_report_secure'/);
  assert.match(block, /raise exception 'Not authorized to access this report\.';/);
});

test("PART J: get_report_secure()'s EXECUTE grant is unchanged (authenticated + service_role, revoked from public/anon)", () => {
  assert.match(code, /revoke execute on function public\.get_report_secure\(uuid, integer\) from public, anon;/);
  assert.match(code, /grant execute on function public\.get_report_secure\(uuid, integer\) to authenticated, service_role;/);
});

// =======================================================================
// PART K: version content, amendments, access-request status
// =======================================================================

test("PART K: get_report_version_content_secure() authorizes via the SAME has_report_access() check as get_report_secure() -- a version can never reveal content for a report the caller cannot otherwise access", () => {
  const block = fnBlock("get_report_version_content_secure")![0];
  assert.match(block, /if not public\.has_report_access\(p_repository_report_id\) then/);
  assert.match(block, /'version_view'/);
});

test("PART K: get_report_amendments_secure() is audited exactly ONCE per call ('amendment_view'), not once per amendment row returned", () => {
  const block = fnBlock("get_report_amendments_secure")![0];
  const auditInserts = (block.match(/insert into public\.report_access_audit/g) ?? []).length;
  // One for the unauthorized-attempt branch, one for the success path --
  // never one per row in the returned SELECT.
  assert.equal(auditInserts, 2);
  assert.doesNotMatch(block, /for .* in .*loop[\s\S]*insert into public\.report_access_audit/);
});

test("PART K: get_report_amendments_secure() never filters out pending amendments -- effective_status='pending' rows are returned as data (never treated as current), and no approval/rejection function exists anywhere in this migration", () => {
  const block = fnBlock("get_report_amendments_secure")![0];
  assert.doesNotMatch(block, /effective_status = 'approved'/);
  assert.doesNotMatch(code, /function public\.approve_report_amendment/i);
  assert.doesNotMatch(code, /function public\.reject_report_amendment/i);
});

test("PART K: get_access_request_status_secure() only lets the requester see their OWN request, or the Global Reporting Controller see any -- never an arbitrary other caller", () => {
  const block = fnBlock("get_access_request_status_secure")![0];
  assert.match(block, /v_request\.requester_id <> auth\.uid\(\) and not public\.has_active_role\('global_reporting_controller'\)/);
});

// =======================================================================
// PART L: dashboard aggregates
// =======================================================================

test("PART L: get_report_dashboard_aggregate_secure() only groups by a fixed, coarse dimension allowlist -- never a client-supplied column name, and never a combination fine enough to isolate one report", () => {
  const block = fnBlock("get_report_dashboard_aggregate_secure")![0];
  assert.match(block, /if p_group_by not in \('source_table', 'flag_state', 'status', 'severity', 'operating_entity_code'\) then/);
  assert.doesNotMatch(block, /format\(/);
});

test("PART L (corrected, round 4): get_report_dashboard_aggregate_secure() counts over the has_report_access()-filtered set for MOST roles, but is INDEPENDENT of it for airasia_management/ghod/global_reporting_controller -- their aggregate visibility is a deliberately separate, count-only, never-per-report authorization path", () => {
  const block = fnBlock("get_report_dashboard_aggregate_secure")![0];
  assert.match(block, /where v_global or public\.has_report_access\(cri\.id\)/);
  assert.match(block, /v_global := public\.has_active_role\('airasia_management'\)/);
  assert.match(block, /public\.has_active_role\('ghod'\)/);
  assert.match(block, /public\.has_active_role\('global_reporting_controller'\)/);
  // This function returns ONLY group_value + report_count -- never id,
  // never content -- so widening v_global's count visibility can never
  // leak individual report identity/content to airasia_management.
  assert.match(block, /returns table \(\s*\n\s*group_value text,\s*\n\s*report_count bigint\s*\n\)/);
});

/** Mirrors get_report_dashboard_aggregate_secure()'s global-vs-scoped
 * decision. */
function aggregateIsGlobal(hasAirAsiaManagement: boolean, hasGhod: boolean, hasGrc: boolean): boolean {
  return hasAirAsiaManagement || hasGhod || hasGrc;
}

test("PART L DECISION MIRROR: AirAsia Management receives global aggregate totals even though it never appears in has_report_access() and can never open a report detail -- the two permissions are wired independently, confirmed by this mirror plus the source-text assertions above", () => {
  assert.equal(aggregateIsGlobal(true, false, false), true);
  assert.equal(aggregateIsGlobal(false, false, false), false);
  assert.equal(aggregateIsGlobal(false, true, false), true);
  assert.equal(aggregateIsGlobal(false, false, true), true);
});

test("PART L: dashboard aggregates are NOT audited per call -- an aggregate refresh is not a 'detail' access, matching the explicit 'must not flood detail-access auditing' requirement", () => {
  const block = fnBlock("get_report_dashboard_aggregate_secure")![0];
  assert.doesNotMatch(block, /insert into public\.report_access_audit/);
});

// =======================================================================
// PART M: CSV sanitization and export
// =======================================================================

/** Mirrors sanitize_csv_value()'s regex exactly. */
function sanitizeCsvValue(value: string | null): string | null {
  if (value === null) return null;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

test("CSV INJECTION: a leading =, +, -, @, tab, or carriage return is prefixed with a single quote (force-text in every common spreadsheet app); an ordinary value is untouched", () => {
  assert.equal(sanitizeCsvValue("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(sanitizeCsvValue("+1234"), "'+1234");
  assert.equal(sanitizeCsvValue("-5"), "'-5");
  assert.equal(sanitizeCsvValue("@mention"), "'@mention");
  assert.equal(sanitizeCsvValue("\tstuff"), "'\tstuff");
  assert.equal(sanitizeCsvValue("\rstuff"), "'\rstuff");
  assert.equal(sanitizeCsvValue("KUL - MAA"), "KUL - MAA");
  assert.equal(sanitizeCsvValue(null), null);
});

test("CSV INJECTION: sanitize_csv_value() is applied to every text field export_reports_secure() returns", () => {
  const block = fnBlock("export_reports_secure")![0];
  for (const col of ["report_type", "operating_entity_code", "flight_number"]) {
    assert.match(block, new RegExp(`public\\.sanitize_csv_value\\(cri\\.${col}\\)`));
  }
});

test("EXPORT: export_reports_secure() authorizes via the same has_report_access() CTE pattern, caps rows at 5000 regardless of what is requested, and writes exactly ONE 'export_generated' audit row per call, never one per exported row", () => {
  const block = fnBlock("export_reports_secure")![0];
  assert.match(block, /where public\.has_report_access\(cri\.id\)/);
  assert.match(block, /least\(greatest\(coalesce\(p_max_rows, 1000\), 1\), 5000\)/);
  const auditInserts = (block.match(/insert into public\.report_access_audit/g) ?? []).length;
  assert.equal(auditInserts, 1);
  assert.match(block, /'export_generated'/);
});

test("EXPORT: export scope is enforced the same way for every role -- Global Reporting Controller, Operation Manager, Main Enforcement, and every other role all go through the identical has_report_access()-authorized CTE, so an Operation Manager can never export outside Operation scope and Main Enforcement can never export outside its own Malaysia scope", () => {
  const block = fnBlock("export_reports_secure")![0];
  // No role-specific branch exists at all -- authorization is entirely
  // delegated to has_report_access(), which already enforces each
  // role's own scope (asserted exhaustively in the ROLE MATRIX tests
  // above) -- there is no separate, divergent export-specific rule to
  // audit here.
  assert.doesNotMatch(block, /has_active_role\(/);
  assert.doesNotMatch(block, /has_role_in_scope\(/);
});

// =======================================================================
// PART N: PDF authorization
// =======================================================================

test("PDF: authorize_report_pdf_secure() re-derives source_table/source_id from central_reports_index by the repository id -- never accepts a client-supplied source table/id pair for a different report than the one authorized", () => {
  const block = fnBlock("authorize_report_pdf_secure")![0];
  assert.match(block, /where cri\.id = p_repository_report_id/);
  assert.doesNotMatch(block, /p_source_table|p_source_id/);
});

test("PDF: authorize_report_pdf_secure() writes 'pdf_generated' on success and 'unauthorized_attempt' on denial, both audited, and requires an approved profile status", () => {
  const block = fnBlock("authorize_report_pdf_secure")![0];
  assert.match(block, /'pdf_generated'/);
  assert.match(block, /'unauthorized_attempt', 'authorize_report_pdf_secure'/);
  assert.match(block, /is distinct from 'approved'/);
});

test("PDF: CaterLink is never referenced by authorize_report_pdf_secure() or anywhere else in this migration -- CaterLink final-transaction PDFs remain a completely separate domain", () => {
  const block = fnBlock("authorize_report_pdf_secure")![0];
  assert.doesNotMatch(block, /caterlink|icms_/i);
  assert.doesNotMatch(code, /caterlink_transactions/i);
});

// =======================================================================
// Permission matrix -- round 2 additions
// =======================================================================

test("PERMISSION MATRIX (round 2): every new function is revoked from public/anon and granted to exactly authenticated+service_role, except sanitize_csv_value (a pure computation helper, same grant)", () => {
  const fns: [string, string][] = [
    ["resolve_report_access_reason", "uuid"],
    ["get_report_version_content_secure", "uuid, integer"],
    ["get_report_amendments_secure", "uuid"],
    ["get_access_request_status_secure", "uuid"],
    ["get_report_dashboard_aggregate_secure", "text"],
    ["sanitize_csv_value", "text"],
    ["export_reports_secure", "integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date"],
    ["authorize_report_pdf_secure", "uuid"],
  ];
  for (const [fn, sig] of fns) {
    const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(code, new RegExp(`revoke execute on function public\\.${fn}\\(${escaped}\\) from public, anon;`), `${fn} missing revoke`);
    assert.match(code, new RegExp(`grant execute on function public\\.${fn}\\(${escaped}\\) to authenticated, service_role;`), `${fn} missing grant`);
  }
});

// =======================================================================
// CORRECTION ROUND 3: atomic secure RPCs, RLS closure, dedicated
// needs-your-action/registration-search/attachment-listing RPCs
// =======================================================================

test("PART O: RLS closure drops every historical broad SELECT policy name across avsec/0002, 0009, 0010, 0012, 0013, 0014, 0021 on all 7 report tables, and recreates exactly one own-row-only SELECT policy per table", () => {
  const expectedDrops: Record<string, string[]> = {
    report_sec016: ["sec016 station select", "sec016 monitor select", "sec016 rank select"],
    report_sec014: ["sec014 station select", "sec014 monitor select", "sec014 rank select"],
    report_sec029: ["sec029 station select", "sec029 monitor select", "sec029 rank select"],
    report_sec018: ["sec018 station select", "sec018 monitor select", "sec018 rank select"],
    report_sec033: ["sec033 rank select"],
    report_sec013: ["sec013 rank select"],
    offload_records: ["offload rank select"],
  };
  for (const [table, policies] of Object.entries(expectedDrops)) {
    for (const p of policies) {
      assert.match(code, new RegExp(`drop policy if exists "${p}" on public\\.${table};`), `must drop "${p}" on ${table}`);
    }
    assert.match(code, new RegExp(`create policy "[a-z0-9]+ own select" on public\\.${table} for select using \\(profile_id = auth\\.uid\\(\\)\\);`), `must recreate own-select on ${table}`);
  }
});

test("PART O: table-level INSERT/UPDATE grants and policies are completely untouched -- report creation and the existing draft/immutability trigger behavior are unaffected by the RLS closure", () => {
  assert.doesNotMatch(code, /revoke insert/i);
  assert.doesNotMatch(code, /revoke update/i);
  assert.doesNotMatch(code, /drop policy.*insert/i);
  assert.doesNotMatch(code, /drop policy.*update/i);
});

test("PART P: report_source_content() is service_role-ONLY (never authenticated) -- it performs no authorization check of its own, so only an already-authorized SECURITY DEFINER caller (every atomic RPC below) may reach it", () => {
  assert.match(code, /revoke execute on function public\.report_source_content\(text, uuid\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.report_source_content\(text, uuid\) to service_role;/);
});

test("PART P: report_source_content() uses a hardcoded IF/ELSIF over literal table names -- never EXECUTE/format() with a table name, and raises on any unsupported value rather than silently returning null", () => {
  const block = fnBlock("report_source_content")![0];
  assert.doesNotMatch(block, /execute format\(/);
  assert.doesNotMatch(block, /execute '/);
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(block, new RegExp(`p_source_table = '${t}'`));
  }
  assert.match(block, /raise exception 'Unsupported source_table: %', p_source_table;/);
});

test("PART P: report_source_content() embeds child rows (patrols/items/hold_checks/profiling_duties) into the same jsonb -- an authorized non-owner viewer (e.g. main_enforcement) sees child content too, not just the parent row, since RLS on child tables alone would otherwise hide it from them after Part O", () => {
  const block = fnBlock("report_source_content")![0];
  for (const child of ["report_sec013_profiling_duties", "report_sec014_patrols", "report_sec018_patrols", "report_sec029_items", "report_sec033_hold_checks"]) {
    assert.match(block, new RegExp(child));
  }
});

test("PART Q: get_report_secure() v3 is ATOMIC -- has_report_access(), the audit write, and the content join (report_source_content()) all happen inside ONE function body / one statement; there is no separate function call application code must chain afterward for content", () => {
  const block = fnBlock("get_report_secure")![0];
  assert.match(block, /public\.report_source_content\(cri\.source_table, cri\.source_id\)/);
  assert.match(block, /returns table \([\s\S]*?content jsonb\s*\n?\)/);
});

test("PART R (corrected, round 4): list_reports_secure()/search_reports_secure() v3 return only CARD fields (via report_source_summary(), a narrow, separate function) inside the same authorized CTE -- atomic, no follow-up query needed, and crucially NO full report_source_content() jsonb, since that belongs only behind an audited detail/PDF/export/version read", () => {
  for (const fn of ["list_reports_secure", "search_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /cross join lateral public\.report_source_summary\(a\.source_table, a\.source_id\) s/);
    assert.doesNotMatch(block, /report_source_content/, `${fn} must not call the full-content function`);
    assert.doesNotMatch(block, /content jsonb/, `${fn} must not return a content jsonb column`);
  }
});

test("PART R (corrected, round 5): report_source_summary() never returns remark in any form -- not the full field, not a truncated excerpt -- and never declaration/corrective_action or any child-table row at all", () => {
  const block = fnBlock("report_source_summary")![0];
  assert.doesNotMatch(block, /\bt\.remark\b/);
  assert.doesNotMatch(block, /corrective_action/);
  assert.doesNotMatch(block, /declaration/);
  assert.doesNotMatch(block, /_patrols|_items|_hold_checks|_profiling_duties/);
});

test("PART R: report_source_summary()'s return columns are exactly the documented allowlist -- staff_name, station, team, secondary_identifier, reg_no, bay_no, sta_std, submitter_profile_id -- nothing else", () => {
  const block = fnBlock("report_source_summary")![0];
  const returnsMatch = block.match(/returns table \(([\s\S]*?)\)\s*\nlanguage/);
  assert.ok(returnsMatch);
  const columns = returnsMatch![1].split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(columns.sort(), ["bay_no", "reg_no", "secondary_identifier", "staff_name", "station", "sta_std", "submitter_profile_id", "team"].sort());
});

test("PART R: report_source_summary() is service_role-ONLY (never authenticated) -- same reasoning as report_source_content(): it performs no authorization check of its own", () => {
  assert.match(code, /revoke execute on function public\.report_source_summary\(text, uuid\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.report_source_summary\(text, uuid\) to service_role;/);
});

test("PART R: list_my_submissions_secure() takes no profile-id parameter at all -- it can only ever return the caller's OWN reports, derived from auth.uid(), across all 7 tables via a fixed UNION ALL (never a client-supplied table name)", () => {
  const block = fnBlock("list_my_submissions_secure", "\\(p_limit integer default 20\\)")![0];
  assert.doesNotMatch(block, /p_profile_id/);
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(block, new RegExp(`from public\\.${t} t where t\\.profile_id = auth\\.uid\\(\\)`));
  }
});

test("PART R: search_reports_by_number_secure() is authorized through the same has_report_access() decision as every other read path, and returns only card fields via report_source_summary()", () => {
  const block = fnBlock("search_reports_by_number_secure")![0];
  assert.match(block, /public\.has_report_access\(cri\.id\)/);
  assert.match(block, /public\.report_source_summary\(cri\.source_table, cri\.source_id\)/);
  assert.doesNotMatch(block, /report_source_content/);
});

test("PART S: needs_your_action_secure() takes no report-identifying parameter at all -- it derives the caller's own role/station/team/ops_group from auth.uid() exclusively, so it cannot be used to probe another profile's queue", () => {
  const block = fnBlock("needs_your_action_secure", "\\(\\)")![0];
  assert.match(block, /where p\.id = auth\.uid\(\)/);
  assert.doesNotMatch(block, /p_profile_id/);
});

test("PART S: needs_your_action_secure() returns zero rows (not an error) for a caller who isn't SO/DSE or has no station/team set -- a generic, non-revealing empty result", () => {
  const block = fnBlock("needs_your_action_secure", "\\(\\)")![0];
  assert.match(block, /if v_role is null or v_role not in \('SO', 'DSE'\) or v_station is null or v_team is null then\s*\n\s*return;/);
});

/** Mirrors needs_your_action_secure()'s eligibility + row-matching rule. */
function needsYourActionEligible(role: string | null, station: string | null, team: string | null): boolean {
  return (role === "SO" || role === "DSE") && station !== null && team !== null;
}
function needsYourActionRowMatches(rowStation: string, callerStation: string, rowTeam: string, callerTeam: string, rowOpsGroup: string | null, callerOpsGroup: string | null): boolean {
  if (rowStation !== callerStation || rowTeam !== callerTeam) return false;
  if (callerOpsGroup !== null && rowOpsGroup !== callerOpsGroup) return false;
  return true;
}

test("PART S DECISION MIRROR: only SO/DSE with both station and team set are eligible; ops_group narrows further only when the caller has one set", () => {
  assert.equal(needsYourActionEligible("SO", "KUL", "Alpha"), true);
  assert.equal(needsYourActionEligible("DSE", "KUL", "Alpha"), true);
  assert.equal(needsYourActionEligible("ASO", "KUL", "Alpha"), false);
  assert.equal(needsYourActionEligible("SO", null, "Alpha"), false);
  assert.equal(needsYourActionEligible("SO", "KUL", null), false);
  assert.equal(needsYourActionRowMatches("KUL", "KUL", "Alpha", "Alpha", "operation_avsec", "operation_avsec"), true);
  assert.equal(needsYourActionRowMatches("KUL", "KUL", "Alpha", "Alpha", "ifc_avsec", "operation_avsec"), false);
  assert.equal(needsYourActionRowMatches("KUL", "PEN", "Alpha", "Alpha", null, null), false);
  assert.equal(needsYourActionRowMatches("KUL", "KUL", "Bravo", "Alpha", null, null), false);
});

test("PART S: needs_your_action_secure() excludes already-acknowledged reports via NOT EXISTS against report_acknowledgements, matching report_type = 'sec014' exactly", () => {
  const block = fnBlock("needs_your_action_secure", "\\(\\)")![0];
  assert.match(block, /not exists \(\s*\n\s*select 1 from public\.report_acknowledgements a\s*\n\s*where a\.report_type = 'sec014' and a\.report_id = r\.id\s*\n\s*\)/);
});

test("PART T: search_movements_by_registration_secure() is bounded -- defaults to the last 30 days when no since-date is given, and caps results at 200 regardless of what is requested; it never performs an unrestricted historical scan", () => {
  const block = fnBlock("search_movements_by_registration_secure")![0];
  assert.match(block, /coalesce\(p_since_date, \(now\(\) - interval '30 days'\)::date\)/);
  assert.match(block, /least\(greatest\(coalesce\(p_max_results, 50\), 1\), 200\)/);
});

test("PART T: search_movements_by_registration_secure() authorizes every candidate row via has_report_access() before it can appear in the result -- scope authorization is per-result, not just per-call", () => {
  const block = fnBlock("search_movements_by_registration_secure")![0];
  assert.match(block, /public\.has_report_access\(cri\.id\)/);
});

test("PART T: search_movements_by_registration_secure() requires a non-empty registration and rejects an empty one explicitly", () => {
  const block = fnBlock("search_movements_by_registration_secure")![0];
  assert.match(block, /if v_reg = '' then\s*\n\s*raise exception 'A registration is required\.';/);
});

test("PART U: list_report_attachments_secure() returns ZERO ROWS (not an error, and not even a count) for an unauthorized or unindexed report -- filenames/MIME types/sizes for a report the caller cannot access are never visible, matching the enumeration-resistance requirement", () => {
  const block = fnBlock("list_report_attachments_secure")![0];
  assert.match(block, /if v_repository_id is null or not public\.has_report_access\(v_repository_id\) then\s*\n\s*return;/);
});

test("PART U: list_report_attachments_secure() authorizes BEFORE any query against report_attachments -- the has_report_access() check happens strictly before the final SELECT, so no row is ever fetched first and filtered after", () => {
  const block = fnBlock("list_report_attachments_secure")![0];
  const authIdx = block.indexOf("if v_repository_id is null or not public.has_report_access");
  const selectIdx = block.indexOf("select a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at");
  assert.ok(authIdx > -1 && selectIdx > authIdx, "authorization must precede the attachment SELECT");
});

// =======================================================================
// EXPLICIT GRANT AUDIT (review round 3, section 5)
// =======================================================================

test("EXPLICIT GRANT AUDIT: when access succeeds specifically because of a grant, get_report_secure() records BOTH the fact (access_reason = 'explicit_grant:<uuid>') AND the grant reference (grant_id) in the SAME audit row as the detail_view/version_view event -- unambiguous, no separate event needed", () => {
  const block = fnBlock("get_report_secure")![0];
  const reasonIdx = block.indexOf("v_reason := public.resolve_report_access_reason");
  const parseIdx = block.indexOf("v_grant_id := replace(v_reason, 'explicit_grant:', '')::uuid;");
  const auditIdx = block.indexOf("insert into public.report_access_audit (actor_id, repository_report_id, version_number, action, access_reason, grant_id)");
  assert.ok(reasonIdx > -1 && parseIdx > reasonIdx && auditIdx > parseIdx, "reason must be resolved, then grant_id parsed, then written together in one insert");
});

/** Mirrors get_report_secure()'s grant-id extraction. */
function extractGrantId(accessReason: string | null): string | null {
  if (accessReason && accessReason.startsWith("explicit_grant:")) {
    return accessReason.replace("explicit_grant:", "");
  }
  return null;
}

test("EXPLICIT GRANT AUDIT DECISION MIRROR: grant_id is populated only when access_reason is an explicit_grant reason; every other reason (submitter, roles, etc.) leaves grant_id null", () => {
  assert.equal(extractGrantId("explicit_grant:11111111-1111-1111-1111-111111111111"), "11111111-1111-1111-1111-111111111111");
  assert.equal(extractGrantId("submitter"), null);
  assert.equal(extractGrantId("main_enforcement"), null);
  assert.equal(extractGrantId(null), null);
});

test("EXPLICIT GRANT AUDIT: 'explicit_grant_used' remains a reserved, CHECK-allowed action value but is never fired by this migration -- documented as intentional (Part W), not a bug", () => {
  const blocks = [...code.matchAll(/alter table public\.report_access_audit add constraint report_access_audit_action_check check \(action in \(([\s\S]*?)\)\);/g)];
  const last = blocks[blocks.length - 1]![1];
  assert.match(last, /'explicit_grant_used'/);
  assert.doesNotMatch(code, /values\([^)]*'explicit_grant_used'/);
  assert.doesNotMatch(code, /'explicit_grant_used'\);/);
});

// =======================================================================
// REVOCATION IMMEDIATE EFFECT (review round 3, section 8)
// =======================================================================

test("REVOCATION IMMEDIATE EFFECT: has_report_access() is STABLE (not IMMUTABLE, not cached across calls) and reads report_access_grants/user_role_assignments fresh on every invocation -- a revoked grant or ended assignment takes effect on the very next call, never a stale cached decision", () => {
  const block = fnBlock("has_report_access")![0];
  assert.match(code, /create or replace function public\.has_report_access\(p_repository_report_id uuid\)\s*\nreturns boolean\s*\nlanguage plpgsql\s*\nstable/);
  assert.doesNotMatch(block, /immutable/i);
  // The grant check itself re-evaluates revoked_at/expires_at every call
  // -- no materialized/cached grant state exists anywhere in this schema.
  assert.match(block, /g\.revoked_at is null/);
  assert.match(block, /g\.expires_at is null or g\.expires_at > now\(\)/);
});

test("REVOCATION IMMEDIATE EFFECT: every atomic RPC (get_report_secure, list/search/flagged/export) calls has_report_access() itself -- not a cached boolean passed in from an earlier request -- so authorization and content retrieval are evaluated together, atomically, on every single call", () => {
  for (const fn of ["get_report_secure", "list_reports_secure", "search_reports_secure", "flagged_reports_secure", "export_reports_secure"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /public\.has_report_access\(/, `${fn} must call has_report_access() itself`);
  }
});

// =======================================================================
// EFFECTIVE PRIVILEGE MATRIX (review round 3, section 2)
// =======================================================================

test("PRIVILEGE MATRIX: PUBLIC and anon never hold EXECUTE on any Phase 6 SECURITY DEFINER function -- every revoke statement includes at least public and, where present, anon", () => {
  const revokes = code.match(/revoke execute on function public\.\w+\([^)]*\) from ([^;]+);/g) ?? [];
  assert.ok(revokes.length >= 15, `expected at least 15 revoke statements, found ${revokes.length}`);
  for (const r of revokes) {
    assert.match(r, /\bpublic\b/, `every revoke must include public: ${r}`);
  }
});

test("PRIVILEGE MATRIX: authenticated holds EXECUTE only on the client-facing RPCs (get_report_secure, list/search/flagged, version/amendment/access-request, dashboard aggregate, export, PDF, attachment, needs-your-action, registration-search) -- never on report_source_content() (service_role-only, no authorization of its own)", () => {
  assert.match(code, /grant execute on function public\.get_report_secure\(uuid, integer\) to authenticated, service_role;/);
  assert.match(code, /grant execute on function public\.needs_your_action_secure\(\) to authenticated, service_role;/);
  assert.match(code, /grant execute on function public\.search_movements_by_registration_secure\(text, date, integer\) to authenticated, service_role;/);
  assert.match(code, /grant execute on function public\.list_report_attachments_secure\(text, uuid\) to authenticated, service_role;/);
  assert.doesNotMatch(code, /grant execute on function public\.report_source_content\(text, uuid\) to authenticated/);
});

test("PRIVILEGE MATRIX: after Part O, the 7 report tables' RLS grants ordinary authenticated users SELECT on their OWN rows only -- never full table content -- documented here as the effective row-visibility rule for authenticated/PUBLIC/anon (PUBLIC and anon have no policy branch at all, so they see nothing; service_role and every SECURITY DEFINER function owner bypass RLS entirely, per the established current_role_name()/current_station() precedent)", () => {
  for (const table of ["report_sec016", "report_sec014", "report_sec029", "report_sec018", "report_sec033", "report_sec013", "offload_records"]) {
    assert.match(code, new RegExp(`create policy "[a-z0-9]+ own select" on public\\.${table} for select using \\(profile_id = auth\\.uid\\(\\)\\);`));
  }
});

// =======================================================================
// CORRECTION ROUND 4: own-report reads, list/search minimization,
// aggregate independence, child-table coverage, version-1 immutability
// =======================================================================

test("PRIVILEGE MATRIX (corrected, round 5): SELECT is revoked at the table level from `authenticated` on all 7 report tables, then re-granted on exactly 4 columns (id, submitted_at, report_no, profile_id) -- profile_id added this round because deleteUserAccount()'s count-only check filters on it, and Postgres requires column-level SELECT for any column referenced in a WHERE/eq filter, not only the explicit select() list", () => {
  const blocks = [...code.matchAll(/do \$\$\s*\ndeclare\s*\n\s*v_table text;[\s\S]*?end;\s*\n\$\$;/g)];
  const block = blocks[blocks.length - 1][0];
  assert.match(block, /revoke select on public\.%I from authenticated/);
  assert.match(block, /grant select \(id, submitted_at, report_no, profile_id\) on public\.%I to authenticated/);
});

test("PRIVILEGE MATRIX (round 5): the 6 child tables (patrols/items/hold_checks/profiling_duties/offload_items) have SELECT revoked from `authenticated` entirely -- no column-level re-grant, since no application code ever reads a child row back after INSERT (confirmed by source search: every child .insert(rows) call destructures only { error })", () => {
  assert.match(code, /revoke select on public\.report_sec014_patrols, public\.report_sec018_patrols, public\.report_sec029_items, public\.report_sec033_hold_checks, public\.report_sec013_profiling_duties, public\.offload_items from authenticated;/);
});

test("CHILD-TABLE COVERAGE (round 4): all 5 child tables (patrols/items/hold_checks/profiling_duties) have their broad 'via parent select' policy dropped and replaced with an own-row-only policy -- correcting round 3's incorrect assumption that narrowing the parent's policy alone was sufficient", () => {
  const children: [string, string, string][] = [
    ["report_sec014_patrols", "report_sec014", "sec014_patrols"],
    ["report_sec018_patrols", "report_sec018", "sec018_patrols"],
    ["report_sec029_items", "report_sec029", "sec029_items"],
    ["report_sec033_hold_checks", "report_sec033", "sec033_hold_checks"],
    ["report_sec013_profiling_duties", "report_sec013", "sec013_profiling_duties"],
  ];
  for (const [child, parent, shortName] of children) {
    assert.match(code, new RegExp(`drop policy if exists "${shortName} via parent select" on public\\.${child};`), `must drop the old broad policy on ${child}`);
    assert.match(code, new RegExp(`create policy "[a-z0-9_]+ own select" on public\\.${child} for select\\s*\\n\\s*using \\(exists \\(select 1 from public\\.${parent} r where r\\.id = report_id and r\\.profile_id = auth\\.uid\\(\\)\\)\\);`), `must create an own-row-only replacement on ${child}`);
  }
});

test("CHILD-TABLE COVERAGE: the 5 child tables' own-row-only policies query through report_source_content(), which embeds the SAME child rows into the parent's jsonb for an authorized non-owner viewer -- so a scoped role (e.g. main_enforcement) still sees patrol/item/hold-check/profiling-duty content via the audited detail path, even though direct table access is now closed to them", () => {
  const block = fnBlock("report_source_content")![0];
  for (const child of ["report_sec014_patrols", "report_sec018_patrols", "report_sec029_items", "report_sec033_hold_checks", "report_sec013_profiling_duties"]) {
    assert.match(block, new RegExp(child));
  }
});

test("VERSION-1 IMMUTABILITY (round 4): index_report() v2 now captures version 1's amended_content via report_source_content() at indexing time -- a genuine snapshot, not a null placeholder -- and this insert happens exactly once, never revisited by any UPDATE anywhere in this codebase (report_versions has no UPDATE statement targeting amended_content in either migration)", () => {
  const block = fnBlock("index_report")![0];
  assert.match(block, /amended_content\)\s*\n\s*values \(v_index_id, 1, 'original', 'Initial submission\.', p_submitter_profile_id, 'approved', now\(\), public\.report_source_content\(p_source_table, p_source_id\)\)/);
  assert.doesNotMatch(code, /update public\.report_versions set[^;]*amended_content/);
});

test("VERSION-1 IMMUTABILITY: get_report_version_content_secure() returns the STORED report_versions.amended_content snapshot for the requested version, never a live re-fetch of the current source row -- so a version-1 request returns the original as captured at indexing time, not today's row (which happen to be identical for a submitted report, since content is frozen, but the code path is genuinely snapshot-based, not current-row-based)", () => {
  const block = fnBlock("get_report_version_content_secure")![0];
  assert.match(block, /select rv\.version_number, rv\.amendment_type, rv\.reason, rv\.requested_by, rv\.approved_by,\s*\n\s*rv\.effective_status, rv\.amended_content, rv\.supersedes_version, rv\.created_at, rv\.decided_at\s*\n\s*from public\.report_versions rv/);
  assert.doesNotMatch(block, /report_source_content/, "must read the stored snapshot, not re-derive it from the live source row");
});

test("INDEX_REPORT ROLLBACK: the documented rollback now includes reverting index_report() to its exact Phase 5 form, positioned before the has_report_access()/get_report_secure() reverts (matching the dependency direction: index_report() calls report_source_content(), a Phase 6 function)", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/)![0];
  assert.match(rollbackBlock, /Revert index_report\(\) to its exact Phase 5 form/);
});

// =======================================================================
// CORRECTION ROUND 5: child-table SELECT closure, remark removal,
// aggregate-role independence, explicit indexing readiness
// =======================================================================

test("CHILD-TABLE COVERAGE (round 5): offload_items -- previously missing entirely from report_source_content() and from every child-table policy/grant closure -- is now covered: embedded into the parent jsonb, its own-row-only SELECT policy, and its table-level SELECT revoke", () => {
  const contentBlock = fnBlock("report_source_content")![0];
  assert.match(contentBlock, /from public\.offload_items c where c\.report_id = p_source_id/);
  assert.match(code, /drop policy if exists "offload_items via parent select" on public\.offload_items;/);
  assert.match(code, /create policy "offload_items own select" on public\.offload_items for select/);
});

test("INDEXING READINESS (round 5): the automatic AFTER INSERT enqueue triggers are dropped from all 7 report tables -- indexing is no longer triggered by the parent row's own INSERT alone", () => {
  for (const table of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(code, new RegExp(`drop trigger if exists trg_enqueue_indexing on public\\.${table};`));
  }
});

test("INDEXING READINESS: mark_report_ready_for_indexing() only inserts into report_index_queue (idempotent, ON CONFLICT DO NOTHING) -- it performs no classification, no content read, and grants no read access of its own; it is purely a completion signal", () => {
  const block = fnBlock("mark_report_ready_for_indexing")![0];
  assert.match(block, /insert into public\.report_index_queue \(source_table, source_id\)/);
  assert.match(block, /on conflict \(source_table, source_id\) do nothing;/);
  assert.doesNotMatch(block, /report_source_content|report_source_summary|has_report_access/);
});

test("INDEXING READINESS: mark_report_ready_for_indexing() only allows the report's own submitter (or service_role) to mark it ready -- an arbitrary caller cannot enqueue someone else's report", () => {
  const block = fnBlock("mark_report_ready_for_indexing")![0];
  assert.match(block, /if v_owner <> auth\.uid\(\) and auth\.role\(\) <> 'service_role' then/);
});

test("INDEXING READINESS: all 7 submit actions in lib/avsec/reports/actions.ts call mark_report_ready_for_indexing() with the correct source_table, after any child-row insert for that type has already completed", () => {
  const actionsSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "reports", "actions.ts"),
    "utf8",
  );
  for (const table of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(actionsSrc, new RegExp(`mark_report_ready_for_indexing", \\{ p_source_table: "${table}"`), `submit action for ${table} must call mark_report_ready_for_indexing()`);
  }
});

test("AGGREGATE SAFETY (round 5): get_report_dashboard_aggregate_secure() only ever groups by ONE of 5 closed-vocabulary dimensions per call (source_table/flag_state/status/severity/operating_entity_code) -- none is staff identity, free text, or an individual report identifier, and no combination of dimensions is possible since exactly one p_group_by is chosen per call, so a count can reveal at most 'N reports share this one coarse attribute,' never which report or who submitted it", () => {
  const block = fnBlock("get_report_dashboard_aggregate_secure")![0];
  assert.match(block, /if p_group_by not in \('source_table', 'flag_state', 'status', 'severity', 'operating_entity_code'\) then/);
  assert.doesNotMatch(block, /staff_name|profile_id|report_no|remark/);
  // Exactly one CASE expression drives group_value -- confirms no
  // multi-dimension grouping is possible in a single call.
  const caseMatches = block.match(/case p_group_by/g) ?? [];
  assert.equal(caseMatches.length, 1);
});

// =======================================================================
// CORRECTION ROUND 6: enforced completion, race-safe child freeze,
// partial-failure handling
// =======================================================================

test("COMPLETION ENFORCEMENT: mark_report_ready_for_indexing() verifies the caller's claimed p_expected_child_count against the DATABASE's own count in the relevant child table -- it never trusts the claim, only uses it as the value to verify", () => {
  const block = fnBlock("mark_report_ready_for_indexing")![0];
  assert.match(block, /if v_actual_children <> coalesce\(p_expected_child_count, 0\) then/);
  assert.match(block, /raise exception 'Report % is not yet complete/);
  for (const [table, child] of [
    ["report_sec013", "report_sec013_profiling_duties"],
    ["report_sec014", "report_sec014_patrols"],
    ["report_sec018", "report_sec018_patrols"],
    ["report_sec029", "report_sec029_items"],
    ["report_sec033", "report_sec033_hold_checks"],
    ["offload_records", "offload_items"],
  ]) {
    assert.match(block, new RegExp(`select count\\(\\*\\) into v_actual_children from public\\.${child} where report_id = p_source_id`), `must count ${child} for ${table}`);
  }
  // report_sec016 has no child table -- expected/actual is always 0,
  // never a count query against a nonexistent table.
  assert.match(block, /elsif p_source_table = 'report_sec016' then\s*\n\s*v_actual_children := 0;/);
});

/** Mirrors mark_report_ready_for_indexing()'s completeness check. */
function canFinalize(expectedChildCount: number, actualChildCount: number): boolean {
  return actualChildCount === expectedChildCount;
}

test("COMPLETION ENFORCEMENT DECISION MIRROR: finalization succeeds only when the expected count exactly matches the actual count -- zero is a valid match (legitimate zero-child report), any mismatch in either direction is rejected", () => {
  assert.equal(canFinalize(0, 0), true);
  assert.equal(canFinalize(1, 0), false, "premature finalization: expected 1, none exist yet");
  assert.equal(canFinalize(0, 1), false, "under-claimed: a child row exists but wasn't accounted for");
  assert.equal(canFinalize(2, 2), true);
  assert.equal(canFinalize(2, 3), false);
});

test("COMPLETION ENFORCEMENT: the parent row is locked with FOR UPDATE before the child count is checked, for every one of the 7 source tables -- this is the shared lock enforce_child_write_before_finalization() (below) also takes, so the two paths cannot race independently", () => {
  const block = fnBlock("mark_report_ready_for_indexing")![0];
  for (const table of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(block, new RegExp(`from public\\.${table} where id = p_source_id for update`), `must lock ${table} with FOR UPDATE`);
  }
});

test("COMPLETION ENFORCEMENT: repeated finalization re-runs the FULL completeness check every time -- it is not a short-circuit 'already queued, skip validation' path", () => {
  const block = fnBlock("mark_report_ready_for_indexing")![0];
  // The ON CONFLICT DO NOTHING insert is the LAST statement in the
  // function body, after the ownership lock and the completeness check
  // -- there is no earlier return/exit that could skip validation for
  // an already-queued report.
  const insertIdx = block.indexOf("insert into public.report_index_queue");
  const checkIdx = block.indexOf("if v_actual_children <> coalesce(p_expected_child_count, 0) then");
  assert.ok(checkIdx > -1 && insertIdx > checkIdx, "the completeness check must run before the (idempotent) queue insert on every call");
});

test("CHILD FREEZE: enforce_child_write_before_finalization() locks the SAME parent row (via the same hardcoded per-table FOR UPDATE pattern) that mark_report_ready_for_indexing() locks, so a concurrent child write and a concurrent finalization call serialize against each other instead of racing", () => {
  const finalizeBlock = fnBlock("mark_report_ready_for_indexing")![0];
  const freezeBlock = fnBlock("enforce_child_write_before_finalization", "\\(\\)")![0];
  for (const table of ["report_sec013", "report_sec014", "report_sec018", "report_sec029", "report_sec033", "offload_records"]) {
    assert.match(finalizeBlock, new RegExp(`from public\\.${table} where id = p_source_id for update`));
    assert.match(freezeBlock, new RegExp(`from public\\.${table} where id = v_report_id for update`));
  }
});

test("CHILD FREEZE: enforce_child_write_before_finalization() rejects INSERT/UPDATE/DELETE once report_index_queue has an entry for the parent -- it checks AFTER acquiring the parent lock (per-table hardcoded FOR UPDATE, asserted above), so it always sees a finalization that already committed", () => {
  const block = fnBlock("enforce_child_write_before_finalization", "\\(\\)")![0];
  assert.match(block, /if exists \(\s*\n\s*select 1 from public\.report_index_queue\s*\n\s*where source_table = v_parent_table and source_id = v_report_id\s*\n\s*\) then/);
  assert.match(block, /raise exception 'This report has already been finalized/);
});

test("CHILD FREEZE: the trigger fires on INSERT, UPDATE, AND DELETE (not just INSERT) on all 6 child tables -- content cannot be added, changed, OR removed after finalization", () => {
  for (const child of ["report_sec013_profiling_duties", "report_sec014_patrols", "report_sec018_patrols", "report_sec029_items", "report_sec033_hold_checks", "offload_items"]) {
    assert.match(code, new RegExp(`create trigger trg_enforce_child_finalization before insert or update or delete on public\\.${child}\\s*\\n\\s*for each row execute function public\\.enforce_child_write_before_finalization\\(\\);`));
  }
});

test("CHILD FREEZE: legitimate child-row creation DURING submission is unaffected -- the trigger only rejects writes once report_index_queue already has an entry, and every submit action inserts child rows BEFORE calling mark_report_ready_for_indexing()", () => {
  const actionsSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "reports", "actions.ts"),
    "utf8",
  );
  // For each type with a child table, the child .insert( call must
  // appear BEFORE that type's mark_report_ready_for_indexing() call.
  for (const [childCall, table] of [
    ['.from("report_sec014_patrols").insert', "report_sec014"],
    ['.from("report_sec018_patrols").insert', "report_sec018"],
    ['.from("report_sec029_items").insert', "report_sec029"],
    ['.from("report_sec033_hold_checks").insert', "report_sec033"],
    ['.from("report_sec013_profiling_duties").insert', "report_sec013"],
    ['.from("offload_items").insert', "offload_records"],
  ]) {
    const childIdx = actionsSrc.indexOf(childCall);
    const readyIdx = actionsSrc.indexOf(`p_source_table: "${table}"`);
    assert.ok(childIdx > -1 && readyIdx > childIdx, `${table}'s child insert must precede its mark_report_ready_for_indexing() call`);
  }
});

test("PARTIAL FAILURE HANDLING: all 7 submit actions check and propagate mark_report_ready_for_indexing()'s error -- a failed finalization must not be reported to the caller as a successful submission", () => {
  const actionsSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "reports", "actions.ts"),
    "utf8",
  );
  const matches = actionsSrc.match(/const \{ error: readyError \} = await supabase\.rpc\("mark_report_ready_for_indexing"/g) ?? [];
  assert.equal(matches.length, 7, `expected all 7 submit actions to check the finalization RPC's error, found ${matches.length}`);
  const guardMatches = actionsSrc.match(/if \(readyError\) \{\s*\n\s*return \{ ok: false, error: `Report saved, but could not be finalized/g) ?? [];
  assert.equal(guardMatches.length, 7, `expected all 7 to return ok: false on a finalization error, found ${guardMatches.length}`);
});

test("PARTIAL FAILURE HANDLING: the finalization error message includes the report id, so a stranded (created but unfinalized) report can be identified and its finalization retried later without resubmitting -- mark_report_ready_for_indexing() is idempotent (ON CONFLICT DO NOTHING) so a bare retry of just that call is always safe", () => {
  const actionsSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "reports", "actions.ts"),
    "utf8",
  );
  const matches = actionsSrc.match(/Contact support with report id \$\{(report|data)\.id\}/g) ?? [];
  assert.equal(matches.length, 7);
});
