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

test("STATIC: no arbitrary table-name execution -- no dynamic SQL (EXECUTE/format) anywhere in this migration's new functions", () => {
  assert.doesNotMatch(code, /execute format\(/i);
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

test("ROLE MATRIX: report acknowledgement/ops_group isolation is unchanged by Phase 6 -- this migration does not touch the acknowledgement column, report_acknowledgements table, or any ops_group check anywhere", () => {
  assert.doesNotMatch(code, /acknowledgement/);
  assert.doesNotMatch(code, /ops_group/);
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

test("ATTACHMENTS: this function is NOT yet called from lib/avsec/attachments/actions.ts -- confirmed unwired, documented as a deferred migration step, existing attachment access is unaffected", () => {
  const attachmentsActions = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "attachments", "actions.ts"),
    "utf8",
  );
  assert.doesNotMatch(attachmentsActions, /get_attachment_authorization_secure/);
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

test("NON-REGRESSION: this migration touches only report_access_audit's CHECK constraint and central_reports_index/report_access_grants/report_access_audit's indexes -- no CREATE TABLE, no ALTER ... ADD COLUMN, no DROP of anything", () => {
  assert.doesNotMatch(code, /create table/i);
  assert.doesNotMatch(code, /add column/i);
  assert.doesNotMatch(code, /drop table/i);
  assert.doesNotMatch(code, /drop column/i);
});

test("NON-REGRESSION: no RLS policy is created, altered, or dropped -- access remains exclusively through SECURITY DEFINER functions", () => {
  assert.equal((code.match(/(create|alter|drop) policy/gi) ?? []).length, 0);
});

test("NON-REGRESSION: this migration does not reference report creation, submission, or the block_submitted_report_mutation()/enforce_report_row_immutability()/derive_report_classification() triggers at all -- Phase 6 is read-access only", () => {
  assert.doesNotMatch(code, /block_submitted_report_mutation/);
  assert.doesNotMatch(code, /enforce_report_row_immutability/);
  assert.doesNotMatch(code, /derive_report_classification/);
});

test("NON-REGRESSION: CaterLink is never referenced by has_report_access() or any new RPC -- CaterLink's own domain (transactions, incidents, archive, PDFs) is completely untouched by this migration", () => {
  assert.doesNotMatch(code, /caterlink_transactions|icms_/i);
});

test("PHASE BOUNDARY: this migration does not execute the Phase 5 backfill, does not activate or reference the Malaysia production hierarchy, and does not migrate existing production accounts -- purely additive schema/function work", () => {
  assert.doesNotMatch(code, /insert into public\.central_reports_index/);
  assert.doesNotMatch(code, /update public\.profiles/);
});

// =======================================================================
// ROLLBACK
// =======================================================================

test("ROLLBACK: documents dropping the 4 new functions before reverting has_report_access() to its Phase 5 form and widening report_access_audit's constraint back, then dropping the new indexes last", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/)![0];
  const fnDropIdx = rollbackBlock.indexOf("drop function if exists public.get_attachment_authorization_secure(uuid);");
  const revertIdx = rollbackBlock.indexOf("Revert has_report_access() to its exact Phase 5 form");
  const constraintIdx = rollbackBlock.indexOf("Revert report_access_audit's CHECK constraint");
  const indexDropIdx = rollbackBlock.indexOf("drop index if exists public.central_reports_index_report_date_idx;");
  assert.ok(fnDropIdx > -1 && revertIdx > fnDropIdx && constraintIdx > revertIdx && indexDropIdx > constraintIdx);
});
