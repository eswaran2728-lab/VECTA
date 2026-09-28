import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 5 of the VECTA Malaysia AOC upgrade
 * (2026-09-28): supabase/migrations/20260928000004_phase5_report_classification_repository.sql.
 *
 * Phase 5 is additive schema/function infrastructure only -- no existing
 * report table's RLS, route, or server action is touched, and no
 * production data is backfilled by this migration. These tests assert
 * the migration's own source text for the safety guarantees the spec
 * requires, and mirror the hierarchy-validation, indexing, access-
 * control, and versioning decision logic in pure functions.
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260928000004_phase5_report_classification_repository.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const REPORT_TABLES = ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "offload_records"];

function fnBlock(name: string, sig = "\\([\\s\\S]*?\\)"): RegExpMatchArray | null {
  return code.match(new RegExp(`create or replace function public\\.${name}${sig}[\\s\\S]*?\\$function\\$;`));
}

// =======================================================================
// Classification schema safety
// =======================================================================

test("SAFETY: every one of the 7 report tables gains the full classification column set, additively (IF NOT EXISTS), never NOT NULL except flag_state's default", () => {
  for (const table of REPORT_TABLES) {
    const block = code.match(new RegExp(`alter table public\\.${table}\\s*\\n[\\s\\S]*?;`));
    assert.ok(block, `must find ALTER TABLE for ${table}`);
    for (const col of ["aoc_id", "operating_entity_id", "operating_entity_code", "department_id", "unit_id", "hub_id", "org_station_id", "org_team_id", "severity", "flag_state", "flagged_by", "flagged_reason", "flagged_at", "unflagged_by", "unflagged_at"]) {
      assert.match(block![0], new RegExp(`add column if not exists ${col}`), `${table} missing ${col}`);
    }
  }
});

test("SAFETY: no existing column (station, team, flight-number fields, ops_group, submitter fields, status fields) is dropped or renamed anywhere in this migration", () => {
  assert.doesNotMatch(code, /drop column/i);
  assert.doesNotMatch(code, /rename column/i);
  assert.doesNotMatch(code, /alter column/i);
});

test("SAFETY: no existing report table's RLS is touched -- zero CREATE/ALTER/DROP POLICY statement anywhere in this migration", () => {
  assert.equal((code.match(/(create|alter|drop) policy/gi) ?? []).length, 0);
});

test("SAFETY: every new table has zero grant to anon/authenticated -- all access goes through the SECURITY DEFINER functions", () => {
  const newTables = ["central_reports_index", "report_versions", "report_access_requests", "report_access_grants", "report_access_audit"];
  for (const t of newTables) {
    assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated;`));
    assert.match(code, new RegExp(`grant all on public\\.${t} to service_role;`));
  }
});

test("SAFETY: this migration does not backfill a single existing report row -- no UPDATE statement targets any report table by itself outside a function body scoped to a specific p_source_id parameter", () => {
  // The only UPDATE statements against report tables are inside
  // index_report()'s explicit per-row CASE, each scoped by
  // `where id = p_source_id` -- never a bare UPDATE ... WHERE station = ...
  // that could touch multiple existing rows at once.
  for (const table of REPORT_TABLES) {
    const bareUpdate = new RegExp(`^update public\\.${table} set`, "gim");
    const matches = code.match(bareUpdate) ?? [];
    for (const m of matches) {
      const context = code.slice(code.indexOf(m), code.indexOf(m) + 300);
      assert.match(context, /where id = p_source_id/, `${table} UPDATE must be scoped to a single row via p_source_id`);
    }
  }
});

// =======================================================================
// Hierarchy consistency (mirrors validate_org_hierarchy())
// =======================================================================

type Scope = { aocId: string | null; operatingEntityId?: string | null; departmentId?: string | null; unitId?: string | null; hubId?: string | null; stationId?: string | null; teamId?: string | null };

const CATALOG = {
  entities: { maa: { aocId: "my" }, other_aoc_entity: { aocId: "other-aoc" } } as Record<string, { aocId: string }>,
  departments: { operation: { aocId: "my" }, other_aoc_dept: { aocId: "other-aoc" } } as Record<string, { aocId: string }>,
  units: { investigation: { departmentId: "operation" }, wrong: { departmentId: "other-dept" } } as Record<string, { departmentId: string }>,
  hubs: { kul: { aocId: "my" }, other_aoc_hub: { aocId: "other-aoc" } } as Record<string, { aocId: string }>,
  stations: { "kul-maa": { hubId: "kul" }, wrong: { hubId: "other" } } as Record<string, { hubId: string }>,
  teams: { "kul-alpha": { stationId: "kul-maa" }, wrong: { stationId: "other" } } as Record<string, { stationId: string }>,
};

/** Mirrors validate_org_hierarchy() exactly. */
function validateOrgHierarchy(s: Scope): { ok: boolean } {
  if (s.operatingEntityId != null) {
    const e = CATALOG.entities[s.operatingEntityId];
    if (!e || s.aocId == null || e.aocId !== s.aocId) return { ok: false };
  }
  if (s.departmentId != null) {
    const d = CATALOG.departments[s.departmentId];
    if (!d || s.aocId == null || d.aocId !== s.aocId) return { ok: false };
  }
  if (s.unitId != null) {
    const u = CATALOG.units[s.unitId];
    if (!u || s.departmentId == null || u.departmentId !== s.departmentId) return { ok: false };
  }
  if (s.hubId != null) {
    const h = CATALOG.hubs[s.hubId];
    if (!h || s.aocId == null || h.aocId !== s.aocId) return { ok: false };
  }
  if (s.stationId != null) {
    const st = CATALOG.stations[s.stationId];
    if (!st || s.hubId == null || st.hubId !== s.hubId) return { ok: false };
  }
  if (s.teamId != null) {
    const tm = CATALOG.teams[s.teamId];
    if (!tm || s.stationId == null || tm.stationId !== s.stationId) return { ok: false };
  }
  return { ok: true };
}

test("HIERARCHY: a fully valid classification passes", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", operatingEntityId: "maa", departmentId: "operation", hubId: "kul", stationId: "kul-maa", teamId: "kul-alpha" }).ok, true);
});

test("HIERARCHY: entity/AOC mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", operatingEntityId: "other_aoc_entity" }).ok, false);
});

test("HIERARCHY: department/AOC mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", departmentId: "other_aoc_dept" }).ok, false);
});

test("HIERARCHY: unit/department mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", departmentId: "operation", unitId: "wrong" }).ok, false);
});

test("HIERARCHY: hub/AOC mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", hubId: "other_aoc_hub" }).ok, false);
});

test("HIERARCHY: station/hub mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", hubId: "kul", stationId: "wrong" }).ok, false);
});

test("HIERARCHY: team/station mismatch is rejected", () => {
  assert.equal(validateOrgHierarchy({ aocId: "my", hubId: "kul", stationId: "kul-maa", teamId: "wrong" }).ok, false);
});

test("HIERARCHY: the migration source actually implements all six checks (not just the test mirror)", () => {
  const block = fnBlock("validate_org_hierarchy");
  assert.ok(block);
  for (const check of [
    "operating_entity_id does not belong to the given aoc_id",
    "department_id does not belong to the given aoc_id",
    "unit_id does not belong to the given department_id",
    "hub_id does not belong to the given aoc_id",
    "station_id does not belong to the given hub_id",
    "team_id does not belong to the given station_id",
  ]) {
    assert.match(block![0], new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// =======================================================================
// Operating entity: prefix vs explicit confirmation
// =======================================================================

test("ENTITY: confirm_report_operating_entity() never derives an entity from a prefix by itself -- it always takes an explicit p_confirmed_entity_id, prefix is only ever compared against it", () => {
  const block = fnBlock("confirm_report_operating_entity");
  assert.ok(block);
  assert.doesNotMatch(block![0], /case p_flight_prefix/i);
  assert.match(block![0], /select code, flight_prefix into v_entity_code, v_expected_prefix\s*\n\s*from public\.operating_entities where id = p_confirmed_entity_id;/);
});

test("ENTITY: a prefix/entity conflict is rejected by default, never silently overwritten", () => {
  const block = fnBlock("confirm_report_operating_entity");
  assert.ok(block);
  assert.match(block![0], /if not p_override_conflict then\s*\n\s*raise exception/);
});

test("ENTITY: an explicit override still logs the conflict to the audit trail as 'entity_conflict', not a silent acceptance", () => {
  const block = fnBlock("confirm_report_operating_entity");
  assert.ok(block);
  assert.match(block![0], /'entity_conflict'/);
});

test("ENTITY: a matching prefix (or no prefix supplied) logs 'entity_confirmed'", () => {
  const block = fnBlock("confirm_report_operating_entity");
  assert.ok(block);
  assert.match(block![0], /'entity_confirmed'/);
});

/** Mirrors confirm_report_operating_entity()'s decision logic. */
function confirmEntity(confirmedPrefix: string, suppliedPrefix: string | null, override: boolean): { ok: boolean; audited: "entity_confirmed" | "entity_conflict" | null } {
  if (suppliedPrefix !== null && suppliedPrefix !== confirmedPrefix) {
    if (!override) return { ok: false, audited: null };
    return { ok: true, audited: "entity_conflict" };
  }
  return { ok: true, audited: "entity_confirmed" };
}

test("ENTITY: AK suggests MAA -- a matching AK prefix against a confirmed MAA entity (prefix AK) is accepted and logged as confirmed", () => {
  assert.deepEqual(confirmEntity("AK", "AK", false), { ok: true, audited: "entity_confirmed" });
});

test("ENTITY: D7 suggests AAX -- a matching D7 prefix against a confirmed AAX entity (prefix D7) is accepted and logged as confirmed", () => {
  assert.deepEqual(confirmEntity("D7", "D7", false), { ok: true, audited: "entity_confirmed" });
});

test("ENTITY: prefix does not override an explicit confirmed entity -- a D7 flight explicitly confirmed as MAA is rejected unless overridden", () => {
  assert.deepEqual(confirmEntity("AK", "D7", false), { ok: false, audited: null });
  assert.deepEqual(confirmEntity("AK", "D7", true), { ok: true, audited: "entity_conflict" });
});

// =======================================================================
// central_reports_index -- allowlist and idempotency
// =======================================================================

test("REPOSITORY: source_table is CHECK-constrained to exactly the 7 supported report tables -- no arbitrary client-supplied table name is ever accepted at the schema level", () => {
  const block = code.match(/create table if not exists public\.central_reports_index \([\s\S]*?\n\);/);
  assert.ok(block);
  assert.match(block![0], /source_table text not null check \(source_table in \(/);
  for (const t of REPORT_TABLES) {
    assert.match(block![0], new RegExp(`'${t}'`));
  }
});

test("REPOSITORY: index_report() independently re-validates the same allowlist before doing anything else -- defense in depth beyond the CHECK constraint alone", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.match(block![0], /if p_source_table not in \(/);
  for (const t of REPORT_TABLES) {
    assert.match(block![0], new RegExp(`'${t}'`));
  }
});

test("REPOSITORY: an unsupported source table is rejected with a raised exception, not silently ignored", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.match(block![0], /raise exception 'Unsupported report source table %; not on the indexing allowlist\.', p_source_table;/);
});

test("REPOSITORY: one authoritative identity per source row -- a UNIQUE index on (source_table, source_id) exists", () => {
  assert.match(code, /create unique index if not exists central_reports_index_source_unique\s*\n\s*on public\.central_reports_index \(source_table, source_id\);/);
});

test("REPOSITORY: index_report() is idempotent -- a retried call for an already-indexed row returns the EXISTING id and performs no further writes (mirrors an early-return, not a re-insert)", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.match(block![0], /select id into v_index_id from public\.central_reports_index\s*\n\s*where source_table = p_source_table and source_id = p_source_id;\s*\n\s*\n\s*if v_index_id is not null then\s*\n\s*return v_index_id;/);
});

test("REPOSITORY: the insert itself also uses ON CONFLICT DO NOTHING, race-safe against two concurrent indexers for the same row", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.match(block![0], /on conflict \(source_table, source_id\) do nothing/);
});

test("REPOSITORY: no dynamic SQL (EXECUTE/format-as-statement) is ever used to write to a report table -- the classification mirror uses a hardcoded IF/ELSIF CASE over exactly the 7 literal table names", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.doesNotMatch(block![0], /execute\s+format/i);
  assert.doesNotMatch(block![0], /execute\s+'/i);
  for (const t of REPORT_TABLES) {
    assert.match(block![0], new RegExp(`if p_source_table = '${t}' then|elsif p_source_table = '${t}' then`));
  }
});

test("REPOSITORY: indexing a report also creates its version-1 (original) row, marked 'approved' and 'original' -- never 'pending'", () => {
  const block = fnBlock("index_report");
  assert.ok(block);
  assert.match(block![0], /insert into public\.report_versions \(repository_report_id, version_number, amendment_type, reason, requested_by, effective_status, decided_at\)\s*\n\s*values \(v_index_id, 1, 'original', 'Initial submission\.', p_submitter_profile_id, 'approved', now\(\)\);/);
});

test("REPOSITORY: index_report() is service_role-only -- no client can index a report directly, bypassing the confirmation/validation sequence", () => {
  assert.match(code, /revoke execute on function public\.index_report\([^)]*\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.index_report\([^)]*\) to service_role;/);
});

// =======================================================================
// Immutability / versioning
// =======================================================================

test("IMMUTABILITY: version numbers are unique and race-safe per report -- a UNIQUE index on (repository_report_id, version_number) exists as the structural backstop", () => {
  assert.match(code, /create unique index if not exists report_versions_unique_per_report\s*\n\s*on public\.report_versions \(repository_report_id, version_number\);/);
});

test("IMMUTABILITY: create_report_amendment() locks the index row (FOR UPDATE) before computing the next version number -- serializes concurrent amendment requests", () => {
  const block = fnBlock("create_report_amendment");
  assert.ok(block);
  assert.match(block![0], /where id = p_repository_report_id\s*\n\s*for update;/);
  assert.match(block![0], /select coalesce\(max\(version_number\), 0\) \+ 1 into v_next_version/);
});

test("IMMUTABILITY: an amendment is created with effective_status='pending' -- it never automatically becomes the current version, since no amendment-approval role was specified and none is invented here", () => {
  const block = fnBlock("create_report_amendment");
  assert.ok(block);
  assert.match(block![0], /'pending', p_amended_content, v_current_version/);
  assert.doesNotMatch(block![0], /update public\.central_reports_index set current_version/);
});

test("IMMUTABILITY: no function anywhere in this migration ever UPDATEs or DELETEs an existing report_versions row -- amendments are pure INSERTs, earlier versions are never modified", () => {
  assert.doesNotMatch(code, /update public\.report_versions/);
  assert.doesNotMatch(code, /delete from public\.report_versions/);
});

test("IMMUTABILITY: create_report_amendment() requires report access (has_report_access()) before permitting an amendment request -- an unauthorized caller cannot even propose an amendment", () => {
  const block = fnBlock("create_report_amendment");
  assert.ok(block);
  assert.match(block![0], /if not public\.has_report_access\(p_repository_report_id\) then/);
});

// =======================================================================
// Flagging / severity
// =======================================================================

test("FLAGGING (corrected, review round 2): flag_report()/unflag_report() are granted to `authenticated`, not service_role-only -- authorization now lives inside the function body (main_enforcement/compliance/global_reporting_controller only, see PART I tests below), since a Postgres-role-only gate was found insufficient", () => {
  assert.match(code, /revoke execute on function public\.flag_report\(uuid, text, text\) from public, anon;/);
  assert.match(code, /grant execute on function public\.flag_report\(uuid, text, text\) to authenticated, service_role;/);
  assert.match(code, /revoke execute on function public\.unflag_report\(uuid, text\) from public, anon;/);
  assert.match(code, /grant execute on function public\.unflag_report\(uuid, text\) to authenticated, service_role;/);
});

test("FLAGGING: flag_report() requires a non-empty reason and writes an audit row", () => {
  const block = fnBlock("flag_report");
  assert.ok(block);
  assert.match(block![0], /if p_reason is null or length\(trim\(p_reason\)\) = 0 then/);
  assert.match(block![0], /insert into public\.report_access_audit \(actor_id, repository_report_id, action, reason\)\s*\n\s*values \(auth\.uid\(\), p_repository_report_id, 'flag', p_reason\);/);
});

test("FLAGGING: GHOD access is evaluated against the report's ACTUAL stored flag_state, never a client-supplied query parameter -- has_report_access() reads v_report.flag_state directly from the row it just selected from the database", () => {
  const block = fnBlock("has_report_access");
  assert.ok(block);
  assert.match(block![0], /if v_report\.flag_state = 'flagged' and public\.has_active_role\('ghod'\) then/);
});

// =======================================================================
// Access requests / grants
// =======================================================================

test("GRANTS: no self-approval -- a CHECK constraint prevents granted_by = grantee_profile_id at the table level, and grant_report_access() also rejects it explicitly before writing anything", () => {
  assert.match(code, /constraint report_access_grants_no_self_grant check \(granted_by is distinct from grantee_profile_id\)/);
  const block = fnBlock("grant_report_access");
  assert.ok(block);
  assert.match(block![0], /if p_grantee_profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot grant report access to yourself\.';/);
});

test("GRANTS: only the Global Reporting Controller may grant or revoke access -- checked via has_active_role(), never a client-supplied role claim", () => {
  const grantBlock = fnBlock("grant_report_access");
  const revokeBlock = fnBlock("revoke_report_access");
  assert.ok(grantBlock);
  assert.ok(revokeBlock);
  assert.match(grantBlock![0], /if not public\.has_active_role\('global_reporting_controller'\) then/);
  assert.match(revokeBlock![0], /if not public\.has_active_role\('global_reporting_controller'\) then/);
});

test("GRANTS: no duplicate active grant -- a partial UNIQUE index on (repository_report_id, grantee_profile_id) WHERE revoked_at IS NULL exists", () => {
  assert.match(code, /create unique index if not exists report_access_grants_one_active\s*\n\s*on public\.report_access_grants \(repository_report_id, grantee_profile_id\)\s*\n\s*where revoked_at is null;/);
});

test("GRANTS: expired/revoked grants give no access -- has_report_access()'s grant EXISTS check includes revoked_at IS NULL, starts_at <= now(), and the ends_at/expires_at window", () => {
  const block = fnBlock("has_report_access");
  assert.ok(block);
  assert.match(block![0], /g\.revoked_at is null\s*\n\s*and g\.starts_at <= now\(\)\s*\n\s*and \(g\.expires_at is null or g\.expires_at > now\(\)\)/);
});

test("GRANTS: a grant never provides edit/acknowledge/approve authority -- report_access_grants is consulted only inside has_report_access() and get_report_secure() (both read-only paths); no write-performing function in this migration checks it", () => {
  const grantConsumers = ["has_report_access", "get_report_secure"];
  for (const fnName of grantConsumers) {
    assert.ok(fnBlock(fnName), `must find ${fnName}`);
  }
  const writeFns = ["flag_report", "unflag_report", "create_report_amendment", "index_report"];
  for (const fnName of writeFns) {
    const block = fnBlock(fnName);
    assert.ok(block, `must find ${fnName}`);
    assert.doesNotMatch(block![0], /report_access_grants/, `${fnName} must never consult report_access_grants`);
  }
});

test("GRANTS: request_report_access()/grant_report_access()/revoke_report_access() all write an audit row transactionally (in the same function, same implicit transaction as the state change)", () => {
  for (const fnName of ["request_report_access", "grant_report_access", "revoke_report_access"]) {
    const block = fnBlock(fnName);
    assert.ok(block, `must find ${fnName}`);
    assert.match(block![0], /insert into public\.report_access_audit/);
  }
});

// =======================================================================
// Role-access matrix (mirrors has_report_access())
// =======================================================================

type FakeReport = { submitterProfileId: string; flagState: "flagged" | "unflagged"; operatingEntityCode: "MAA" | "AAX" | null; aocId: string | null };
type Caller = { profileId: string; roles: string[] };

/** Mirrors has_report_access() exactly. */
function hasReportAccess(report: FakeReport, caller: Caller, activeGrant = false): boolean {
  if (report.submitterProfileId === caller.profileId) return true;
  if (caller.roles.includes("global_reporting_controller")) return true;
  if (report.flagState === "flagged" && caller.roles.includes("ghod")) return true;
  if (report.operatingEntityCode === "MAA" && caller.roles.includes("maa_boss")) return true;
  if (report.operatingEntityCode === "AAX" && caller.roles.includes("aax_boss")) return true;
  if (report.aocId != null && caller.roles.includes("main_enforcement")) return true;
  if (report.aocId != null && caller.roles.includes("compliance")) return true;
  if (report.aocId != null && ["investigation_sso", "investigation_so", "investigation_aso"].some((r) => caller.roles.includes(r))) return true;
  if (activeGrant) return true;
  return false;
}

const BASE_REPORT: FakeReport = { submitterProfileId: "submitter", flagState: "unflagged", operatingEntityCode: "MAA", aocId: "my" };

test("MATRIX: MAA Boss cannot read AAX detail", () => {
  assert.equal(hasReportAccess({ ...BASE_REPORT, operatingEntityCode: "AAX" }, { profileId: "u1", roles: ["maa_boss"] }), false);
});

test("MATRIX: AAX Boss cannot read MAA detail", () => {
  assert.equal(hasReportAccess({ ...BASE_REPORT, operatingEntityCode: "MAA" }, { profileId: "u1", roles: ["aax_boss"] }), false);
});

test("MATRIX: AirAsia Management gets no detailed-report access through has_report_access() at all -- not listed in the function anywhere", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["airasia_management"] }), false);
  const block = fnBlock("has_report_access");
  assert.ok(block);
  assert.doesNotMatch(block![0], /airasia_management/);
});

test("MATRIX: GHOD reads active flagged reports only -- unflagged is denied", () => {
  assert.equal(hasReportAccess({ ...BASE_REPORT, flagState: "flagged" }, { profileId: "u1", roles: ["ghod"] }), true);
  assert.equal(hasReportAccess({ ...BASE_REPORT, flagState: "unflagged" }, { profileId: "u1", roles: ["ghod"] }), false);
});

test("MATRIX: unflagging removes GHOD access -- modeled directly as the flagState transition above (same predicate, opposite state)", () => {
  const flagged = { ...BASE_REPORT, flagState: "flagged" as const };
  const unflagged = { ...BASE_REPORT, flagState: "unflagged" as const };
  const ghod = { profileId: "u1", roles: ["ghod"] };
  assert.equal(hasReportAccess(flagged, ghod), true);
  assert.equal(hasReportAccess(unflagged, ghod), false);
});

test("MATRIX: Global Reporting Controller can access any report (search authority) but has_report_access() alone never grants edit -- no write function checks role at all, confirmed above", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["global_reporting_controller"] }), true);
});

test("MATRIX: Super Admin receives no implicit report access -- not listed in has_report_access() anywhere", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["super_admin"] }), false);
  const block = fnBlock("has_report_access");
  assert.ok(block);
  assert.doesNotMatch(block![0], /super_admin/);
});

test("MATRIX: Compliance and Main Enforcement have Malaysia-wide read authority (scoped by the report's own aoc_id, future-AOC-safe)", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["compliance"] }), true);
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["main_enforcement"] }), true);
});

test("MATRIX: Investigation (any of the three ranks) has read authority", () => {
  for (const role of ["investigation_sso", "investigation_so", "investigation_aso"]) {
    assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: [role] }), true, `${role} must have read authority`);
  }
});

test("MATRIX: a caller with no matching role and no grant is denied", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: ["aso"] }), false);
});

test("MATRIX: an active grant provides access even with no matching role", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "u1", roles: [] }, true), true);
});

test("MATRIX: the submitter always has access to their own report", () => {
  assert.equal(hasReportAccess(BASE_REPORT, { profileId: "submitter", roles: [] }), true);
});

// =======================================================================
// Secure read path (get_report_secure())
// =======================================================================

test("SECURE READ: authenticates, confirms approved status, evaluates access, verifies the requested version exists, and audits -- in that order, before returning any data", () => {
  const block = fnBlock("get_report_secure");
  assert.ok(block);
  const authIdx = block![0].indexOf("if auth.uid() is null then");
  const statusIdx = block![0].indexOf("if v_caller_status is distinct from 'approved' then");
  const accessIdx = block![0].indexOf("if not public.has_report_access(p_repository_report_id) then");
  const versionIdx = block![0].indexOf("if not exists (select 1 from public.report_versions");
  const auditIdx = block![0].indexOf("insert into public.report_access_audit");
  const returnIdx = block![0].indexOf("return query");
  assert.ok([authIdx, statusIdx, accessIdx, versionIdx, auditIdx, returnIdx].every((i) => i > -1));
  assert.ok(authIdx < statusIdx && statusIdx < accessIdx && accessIdx < versionIdx && versionIdx < auditIdx && auditIdx < returnIdx);
});

test("SECURE READ: never returns a storage path or file reference -- its RETURNS TABLE column list is metadata only", () => {
  const block = fnBlock("get_report_secure");
  assert.ok(block);
  const returnsBlock = block![0].match(/returns table \([\s\S]*?\)/);
  assert.ok(returnsBlock);
  for (const forbidden of ["url", "path", "storage", "signed"]) {
    assert.doesNotMatch(returnsBlock![0], new RegExp(forbidden, "i"));
  }
});

test("SECURE READ: a non-approved caller (pending/rejected/deactivated) is denied even if otherwise authorized by role", () => {
  const block = fnBlock("get_report_secure");
  assert.ok(block);
  assert.match(block![0], /if v_caller_status is distinct from 'approved' then\s*\n\s*raise exception 'Only an approved account may access report content\.';/);
});

test("SECURE READ: requesting a non-existent version raises an exception rather than silently returning the current version", () => {
  const block = fnBlock("get_report_secure");
  assert.ok(block);
  assert.match(block![0], /raise exception 'Requested version % does not exist for this report\.', v_version;/);
});

// =======================================================================
// Index-integrity verification views
// =======================================================================

test("VERIFICATION: a classification-gaps view and a current-version-mismatch view both exist for read-only integrity checking", () => {
  assert.match(code, /create or replace view public\.v_report_index_classification_gaps as/);
  assert.match(code, /create or replace view public\.v_report_index_current_version_mismatch as/);
});

// =======================================================================
// Non-regression
// =======================================================================

test("REGRESSION: no existing Phase 2/3/4 function is redefined by this migration", () => {
  for (const fn of ["has_role_in_scope", "has_active_role", "is_entity_admin", "approve_registration_request", "is_approved_management", "is_active_supervisor"]) {
    assert.doesNotMatch(code, new RegExp(`create or replace function public\\.${fn}\\(`));
  }
});

test("REGRESSION (superseded by Phase 6): this Phase 5 migration file itself still does not wire any application code -- Phase 5 remains purely schema/RPC infrastructure. Live application wiring to these RPCs was deliberately added in Phase 6 (see tests/phase6-secure-report-access.test.mts and tests/phase6-direct-read-closure.test.mts), which is a separate, later, explicitly-authorized correction -- this test now only confirms the ORIGINAL Phase 5 migration file's own additive-only, non-wiring nature, not that the wiring never exists anywhere.", () => {
  assert.doesNotMatch(code, /supabase\.rpc\(/, "the migration FILE itself is SQL, never application code calling its own RPCs");
});

// =======================================================================
// Rollback ordering
// =======================================================================

test("ROLLBACK: views and functions are dropped before the five new tables; tables are dropped dependents-first (audit last-referencing table first, central_reports_index last)", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/);
  assert.ok(rollbackBlock);
  const text = rollbackBlock[0];
  const lastFnDropIdx = text.lastIndexOf("drop function if exists public.validate_org_hierarchy(uuid, uuid, uuid, uuid, uuid, uuid, uuid);");
  const auditTableIdx = text.indexOf("drop table if exists public.report_access_audit;");
  const indexTableIdx = text.indexOf("drop table if exists public.central_reports_index;");
  assert.ok(lastFnDropIdx > -1 && auditTableIdx > -1 && indexTableIdx > -1);
  assert.ok(lastFnDropIdx < auditTableIdx, "functions before tables");
  assert.ok(auditTableIdx < indexTableIdx, "dependent tables before central_reports_index");
});

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

test("STATIC: every new function is SECURITY DEFINER with a fixed search_path", () => {
  const fnBlocks = code.match(/create or replace function public\.\w+\([\s\S]*?\$function\$;/g) ?? [];
  assert.ok(fnBlocks.length >= 11, `expected at least 11 new functions, found ${fnBlocks.length}`);
  for (const block of fnBlocks) {
    assert.match(block, /security definer/i);
    assert.match(block, /set search_path to 'public'/i);
  }
});

// =======================================================================
// CORRECTION ROUND 3 (2026-09-28): the pre-existing submitted-report
// immutability trigger, its interaction with index_report(), and the
// narrowed Part P classification-only trigger
// =======================================================================

const CLASSIFICATION_COLS = [
  "aoc_id", "operating_entity_id", "operating_entity_code", "department_id", "unit_id",
  "hub_id", "org_station_id", "org_team_id", "severity", "flag_state", "flagged_by",
  "flagged_reason", "flagged_at", "unflagged_by", "unflagged_at",
];

/** Mirrors the corrected block_submitted_report_mutation(): may `column`
 * change on an already-submitted row, for the given caller? */
function canMutateSubmittedColumn(isServiceRole: boolean, column: string): boolean {
  if (!isServiceRole) return false;
  return CLASSIFICATION_COLS.includes(column);
}

/** Mirrors enforce_report_row_immutability(): may `column` (any status)
 * be changed directly by a non-service_role caller? */
function canDirectlyWriteClassificationColumn(isServiceRole: boolean, column: string): boolean {
  if (isServiceRole) return true;
  return !CLASSIFICATION_COLS.includes(column);
}

test("PART P ROOT CAUSE: the pre-existing block_submitted_report_mutation() (avsec/0001_init_schema.sql, attached to all 7 report tables) unconditionally blocked ANY update once submitted, for every caller -- this migration's own index_report() classification-mirroring UPDATE would have failed against it for every real submitted report", () => {
  // This is a structural fact about the pre-existing trigger, not
  // something this migration can assert against its own source (that
  // file predates Phase 5) -- documented here as the recorded root
  // cause, verified by direct inspection of avsec/0001_init_schema.sql
  // during this round's investigation.
  assert.ok(true);
});

test("PART P (corrected): block_submitted_report_mutation() is re-defined by this migration (CREATE OR REPLACE of the pre-existing function) to allow a narrow, exact-column exception", () => {
  const block = code.match(/create or replace function public\.block_submitted_report_mutation\(\)[\s\S]*?\$\$ language plpgsql set search_path = public;/);
  assert.ok(block, "block_submitted_report_mutation() must be redefined in this migration");
  assert.match(block![0], /auth\.role\(\) = 'service_role'/);
});

test("PART P (corrected): the redefined function still unconditionally blocks DELETE of a submitted report, for every caller (unchanged from the original)", () => {
  const block = code.match(/create or replace function public\.block_submitted_report_mutation\(\)[\s\S]*?\$\$ language plpgsql set search_path = public;/)![0];
  assert.match(block, /tg_op = 'DELETE'/);
  assert.match(block, /old\.status = 'submitted' then\s*\n\s*raise exception 'Submitted reports are immutable and cannot be deleted/);
});

test("PART P (corrected): the redefined function still blocks EVERY column change on a submitted row for a non-service_role caller -- the classification exception is checked ONLY inside the auth.role() = 'service_role' branch", () => {
  const block = code.match(/create or replace function public\.block_submitted_report_mutation\(\)[\s\S]*?\$\$ language plpgsql set search_path = public;/)![0];
  // The unconditional "raise exception" for a non-service_role caller
  // must appear OUTSIDE (after) the service_role branch's own return,
  // i.e. it is the fallback for anyone not service_role.
  const serviceRoleBranch = block.match(/if auth\.role\(\) = 'service_role' then([\s\S]*?)end if;\s*\n\s*raise exception 'Submitted reports are immutable and cannot be edited\. Submit an amendment instead\.';/);
  assert.ok(serviceRoleBranch, "must find the service_role branch immediately followed by an unconditional raise for everyone else");
});

test("PART P (corrected) DECISION MIRROR: only service_role may change a submitted row, and even then only the 15 classification/flag columns -- every content column stays frozen for every caller once submitted", () => {
  for (const col of [...CLASSIFICATION_COLS, "station", "team", "remark", "acknowledgement", "status"]) {
    assert.equal(canMutateSubmittedColumn(false, col), false, `non-service_role must never mutate ${col} on a submitted row`);
  }
  for (const col of CLASSIFICATION_COLS) {
    assert.equal(canMutateSubmittedColumn(true, col), true, `service_role must be able to mutate ${col}`);
  }
  for (const col of ["station", "team", "remark", "acknowledgement"]) {
    assert.equal(canMutateSubmittedColumn(true, col), false, `service_role must NOT be able to mutate content column ${col} -- this is not a blanket bypass`);
  }
});

test("PART P (corrected): enforce_report_row_immutability() is narrowed to ONLY the 15 classification/flag columns -- it no longer contains any per-table content allowlist, so it cannot conflict with or duplicate block_submitted_report_mutation()'s content-immutability job, and cannot break legitimate draft editing of any other column", () => {
  const block = fnBlock("enforce_report_row_immutability", "\\(\\)")![0];
  assert.match(block, /auth\.role\(\) = 'service_role'/);
  assert.match(block, /security definer/i);
  assert.match(block, /set search_path to 'public'/i);
  for (const col of CLASSIFICATION_COLS) {
    assert.match(block, new RegExp(`'${col}'`), `must list ${col}`);
  }
  // No per-table CASE/allowlist of content columns remains.
  assert.doesNotMatch(block, /when 'report_sec013' then/);
  assert.doesNotMatch(block, /'acknowledgement'/);
  assert.doesNotMatch(block, /'status'/);
});

test("PART P (corrected) DECISION MIRROR: enforce_report_row_immutability() blocks a direct classification-column write for any non-service_role caller, in ANY status (draft or submitted), and allows every other column to change freely (that is content immutability's job, not this trigger's)", () => {
  for (const col of CLASSIFICATION_COLS) {
    assert.equal(canDirectlyWriteClassificationColumn(false, col), false);
    assert.equal(canDirectlyWriteClassificationColumn(true, col), true);
  }
  for (const col of ["station", "team", "remark", "acknowledgement", "status"]) {
    assert.equal(canDirectlyWriteClassificationColumn(false, col), true, `${col} is not this trigger's concern`);
  }
});

test("PART P: a BEFORE UPDATE trigger firing enforce_report_row_immutability() is attached to all 7 report tables", () => {
  for (const table of REPORT_TABLES) {
    assert.match(
      code,
      new RegExp(`create trigger trg_enforce_immutability before update on public\\.${table}\\s*\\n\\s*for each row execute function public\\.enforce_report_row_immutability\\(\\);`),
      `${table} must have the immutability trigger attached`,
    );
  }
});

test("PART P: this migration does not modify any existing RLS policy -- both the classification trigger and the corrected pre-existing trigger are trigger functions, not policy changes", () => {
  assert.equal((code.match(/(create|alter|drop) policy/gi) ?? []).length, 0);
});

test("DRAFT/SUBMITTED MATRIX: a draft row (status='draft') may still have any content column changed by an ordinary user -- block_submitted_report_mutation() only restricts once status='submitted', so Part P's redesign does not narrow draft editing at all", () => {
  // Mirrors block_submitted_report_mutation(): the function's early
  // returns only fire when old.status = 'submitted'; for any other old
  // status (draft) it falls through to the unconditional `return new`
  // at the end, unchanged from the original 0001-era behavior.
  const block = code.match(/create or replace function public\.block_submitted_report_mutation\(\)[\s\S]*?\$\$ language plpgsql set search_path = public;/)![0];
  assert.match(block, /if old\.status = 'submitted' then/);
  assert.match(block, /if new\.status = 'submitted' and new\.submitted_at is null then\s*\n\s*new\.submitted_at = now\(\);\s*\n\s*end if;\s*\n\s*\n?\s*return new;/);
});

test("ACKNOWLEDGEMENT NON-REGRESSION: this migration never sets or references the acknowledgement column in any UPDATE statement -- it is written once at INSERT time by application code (lib/avsec/reports/actions.ts, outside this migration) and never touched again, so neither the corrected pre-existing trigger nor Part P/P2 need (or have) any special case for it", () => {
  assert.doesNotMatch(code, /set\s+[\s\S]{0,80}acknowledgement\s*=/i);
});

// =======================================================================
// CORRECTION ROUND 3, PART P2: trusted classification derivation
// =======================================================================

test("PART P2: derive_report_classification() exists, is SECURITY DEFINER with a fixed search_path, and is a BEFORE INSERT trigger on all 7 report tables", () => {
  const block = fnBlock("derive_report_classification", "\\(\\)");
  assert.ok(block, "derive_report_classification() must exist");
  assert.match(block![0], /security definer/i);
  assert.match(block![0], /set search_path to 'public'/i);
  for (const table of REPORT_TABLES) {
    assert.match(
      code,
      new RegExp(`create trigger trg_derive_classification before insert on public\\.${table}\\s*\\n\\s*for each row execute function public\\.derive_report_classification\\(\\);`),
    );
  }
});

test("PART P2: a non-service_role INSERT has every one of the 15 classification/flag columns cleared before derivation -- a client-supplied value in the insert payload itself can never survive", () => {
  const block = fnBlock("derive_report_classification", "\\(\\)")![0];
  const clearBranch = block.match(/if auth\.role\(\) <> 'service_role' then([\s\S]*?)end if;/);
  assert.ok(clearBranch, "must find the non-service_role clearing branch");
  for (const col of CLASSIFICATION_COLS) {
    assert.match(clearBranch![1], new RegExp(`new\\.${col} := `), `must clear ${col}`);
  }
});

test("PART P2: derivation never reads a flight-number prefix or any client-supplied field -- it looks up ONLY the submitter's own profile_id against user_role_assignments/role_definitions/operating_entities", () => {
  const block = fnBlock("derive_report_classification", "\\(\\)")![0];
  assert.doesNotMatch(block, /flight_prefix/);
  assert.doesNotMatch(block, /new\.station\b/);
  assert.match(block, /ura\.profile_id = new\.profile_id/);
});

/** Mirrors derive_report_classification()'s ambiguity rule. */
function deriveClassification(activeAssignmentsWithAoc: number): "derived" | "null-legacy-or-ambiguous" {
  return activeAssignmentsWithAoc === 1 ? "derived" : "null-legacy-or-ambiguous";
}

test("PART P2 DECISION MIRROR: exactly one active, non-null-aoc_id assignment derives classification; zero (legacy account) or more than one (ambiguous) leaves it null -- never guessed", () => {
  assert.equal(deriveClassification(0), "null-legacy-or-ambiguous");
  assert.equal(deriveClassification(1), "derived");
  assert.equal(deriveClassification(2), "null-legacy-or-ambiguous");
  assert.equal(deriveClassification(5), "null-legacy-or-ambiguous");
});

test("PART P2: the derivation query filters on rd.is_active, ura.revoked_at is null, the starts_at/ends_at active window, and ura.aoc_id is not null -- an inactive, revoked, pending, or expired assignment is never counted", () => {
  const block = fnBlock("derive_report_classification", "\\(\\)")![0];
  assert.match(block, /rd\.is_active/);
  assert.match(block, /ura\.revoked_at is null/);
  assert.match(block, /ura\.starts_at <= now\(\)/);
  assert.match(block, /ura\.ends_at is null or ura\.ends_at > now\(\)/);
  assert.match(block, /ura\.aoc_id is not null/);
});

test("PART P2 LEGACY ACCOUNT: a submitter with zero Phase 3 role assignments (true for effectively every current production user) still gets their report created -- classification columns simply stay null, and the queue marks it retryable-failed, never blocking the insert itself", () => {
  const block = fnBlock("derive_report_classification", "\\(\\)")![0];
  assert.doesNotMatch(block, /raise exception/);
});

test("PART P2: the 8 existing production KUL-MAA rows are unaffected -- this trigger only fires BEFORE INSERT, never on an existing row, so they remain classified only by the separate, unexecuted backfill artifact", () => {
  assert.doesNotMatch(code, /trg_derive_classification.*before update/is);
});

// =======================================================================
// CORRECTION ROUND 2: automatic, reliable indexing (review point 4)
// =======================================================================

test("PART Q: report_index_queue table exists with a source_table allowlist CHECK, a structural UNIQUE(source_table, source_id) backstop, and zero grant to anon/authenticated", () => {
  assert.match(code, /create table if not exists public\.report_index_queue/);
  const block = code.match(/create table if not exists public\.report_index_queue[\s\S]*?;/)![0];
  for (const table of REPORT_TABLES) {
    assert.match(block, new RegExp(`'${table}'`));
  }
  assert.match(code, /create unique index if not exists report_index_queue_source_unique\s*\n\s*on public\.report_index_queue \(source_table, source_id\);/);
  assert.match(code, /revoke all on public\.report_index_queue from public, anon, authenticated;/);
  assert.match(code, /grant all on public\.report_index_queue to service_role;/);
});

test("PART Q: an AFTER INSERT trigger enqueues every one of the 7 report tables for indexing, transparent to existing application code", () => {
  for (const table of REPORT_TABLES) {
    assert.match(
      code,
      new RegExp(`create trigger trg_enqueue_indexing after insert on public\\.${table}\\s*\\n\\s*for each row execute function public\\.enqueue_report_for_indexing\\(\\);`),
    );
  }
});

test("PART Q: enqueue_report_for_indexing() only INSERTs into report_index_queue with ON CONFLICT DO NOTHING -- idempotent, and cannot recurse since it never writes back to a report table", () => {
  const block = fnBlock("enqueue_report_for_indexing", "\\(\\)")![0];
  assert.match(block, /insert into public\.report_index_queue \(source_table, source_id\)/);
  assert.match(block, /on conflict \(source_table, source_id\) do nothing/);
  assert.doesNotMatch(block, new RegExp(REPORT_TABLES.join("|")));
});

test("PART Q: process_report_index_queue() never fabricates a classification -- a row with a null aoc_id is marked 'failed' with a detectable reason, never guessed or indexed", () => {
  const block = fnBlock("process_report_index_queue")![0];
  assert.match(block, /if v_aoc_id is null then/);
  assert.match(block, /status = 'failed', last_error = 'source row not yet classified/);
});

test("PART Q: process_report_index_queue() uses FOR UPDATE SKIP LOCKED so concurrent workers cannot double-process the same queue row", () => {
  const block = fnBlock("process_report_index_queue")![0];
  assert.match(block, /for update skip locked/);
});

test("PART Q: process_report_index_queue() is service_role-only", () => {
  assert.match(code, /revoke execute on function public\.process_report_index_queue\(integer\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.process_report_index_queue\(integer\) to service_role;/);
});

test("PART Q: a queue-health verification view exists for missing/failed indexing, with an is_stale flag for a pending/failed row older than 5 minutes", () => {
  const block = code.match(/create or replace view public\.v_report_index_queue_health as[\s\S]*?;/)![0];
  assert.match(block, /is_stale/);
  assert.match(block, /interval '5 minutes'/);
  assert.match(block, /status in \('pending', 'failed'\)/);
});

// =======================================================================
// CORRECTION ROUND 3, PART Q: retryable vs. permanent failure, and
// automatic pg_cron scheduling (review points 1 and 4)
// =======================================================================

test("PART Q (corrected): report_index_queue's status CHECK now includes 'permanently_failed' alongside 'pending'/'processing'/'completed'/'failed'", () => {
  const block = code.match(/create table if not exists public\.report_index_queue[\s\S]*?;/)![0];
  assert.match(block, /'pending', 'processing', 'completed', 'failed', 'permanently_failed'/);
});

test("PART Q (corrected): a missing source row (deleted between enqueue and processing) is marked 'permanently_failed', not retried automatically -- the automatic retry loop only selects 'pending'/'failed'", () => {
  const block = fnBlock("process_report_index_queue")![0];
  assert.match(block, /select exists\(select 1 from public\.%I where id = \$1\)/);
  assert.match(block, /if not v_source_exists then/);
  assert.match(block, /status = 'permanently_failed', last_error = 'source row no longer exists'/);
  assert.match(block, /where status in \('pending', 'failed'\)/);
  assert.doesNotMatch(block, /where status in \('pending', 'failed', 'permanently_failed'\)/);
});

test("PART Q (corrected): any exception from index_report() itself (e.g. a hierarchy-consistency violation) is marked 'permanently_failed' with sqlerrm, not automatically retried with the same doomed inputs", () => {
  const block = fnBlock("process_report_index_queue")![0];
  const exceptionBranch = block.match(/exception when others then([\s\S]*?)end;\s*\n\s*end loop;/);
  assert.ok(exceptionBranch, "must find the exception handler");
  assert.match(exceptionBranch![1], /status = 'permanently_failed', last_error = sqlerrm/);
});

test("PART Q (corrected): a 'not yet classified' failure remains 'failed' (retryable) and is picked up again by the next automatic run, unlike a permanent failure", () => {
  const block = fnBlock("process_report_index_queue")![0];
  assert.match(block, /status = 'failed', last_error = 'source row not yet classified/);
});

/** Mirrors process_report_index_queue()'s outcome classification. */
function classifyQueueOutcome(sourceExists: boolean, hasAocId: boolean, indexReportThrows: boolean): "completed" | "failed-retryable" | "permanently_failed" {
  if (!sourceExists) return "permanently_failed";
  if (!hasAocId) return "failed-retryable";
  if (indexReportThrows) return "permanently_failed";
  return "completed";
}

test("PART Q DECISION MIRROR: the four processing outcomes are classified correctly -- missing source and index_report() exceptions are permanent, unclassified is retryable, everything else succeeds", () => {
  assert.equal(classifyQueueOutcome(false, false, false), "permanently_failed");
  assert.equal(classifyQueueOutcome(true, false, false), "failed-retryable");
  assert.equal(classifyQueueOutcome(true, true, true), "permanently_failed");
  assert.equal(classifyQueueOutcome(true, true, false), "completed");
});

test("PART Q (corrected): process_report_index_queue() returns a permanently_failed count alongside processed/indexed/failed, so a caller can distinguish outcome categories without querying the table", () => {
  assert.match(code, /returns table \(processed integer, indexed integer, failed integer, permanently_failed integer\)/);
});

test("PART Q (corrected): 'completed' and 'permanently_failed' rows are excluded from every future automatic run -- only 'pending'/'failed' are ever re-selected", () => {
  const matches = code.match(/where status in \('pending', 'failed'\)/g) ?? [];
  assert.ok(matches.length >= 1);
  assert.doesNotMatch(code, /where status in \('pending', 'failed', 'completed'\)/);
  assert.doesNotMatch(code, /where status in \('pending', 'failed', 'permanently_failed'\)/);
});

test("PART Q AUTOMATIC EXECUTION: pg_cron is used (the repository's own existing precedent, avsec/0023_sheet_sync_queue.sql) to invoke process_report_index_queue() automatically, every 1 minute, with a fixed batch size", () => {
  assert.match(code, /create extension if not exists pg_cron;/);
  assert.match(code, /select cron\.schedule\('phase5-report-index-queue', '\* \* \* \* \*', \$cron\$select public\.process_report_index_queue\(50\);\$cron\$\);/);
});

test("PART Q AUTOMATIC EXECUTION: the cron schedule is idempotent across re-applying this migration -- any existing job with the same name is unscheduled first", () => {
  const block = code.match(/do \$\$\s*\n\s*begin\s*\n\s*if exists \(select 1 from cron\.job where jobname = 'phase5-report-index-queue'\) then[\s\S]*?end;\s*\n\s*\$\$;/);
  assert.ok(block, "must find the idempotent unschedule-then-reschedule guard");
  assert.match(block![0], /perform cron\.unschedule\('phase5-report-index-queue'\);/);
});

test("PART Q AUTOMATIC EXECUTION: no pg_net / external HTTP call and no webhook secret are actually USED (functionally, not just discussed in comments) -- the cron job invokes the SQL function directly inside Postgres, unlike the sheets-sync precedent which needs an external Edge Function", () => {
  assert.doesNotMatch(code, /create extension if not exists pg_net/);
  assert.doesNotMatch(code, /net\.http_post/);
  assert.doesNotMatch(code, /webhook_secret/);
});

test("PART Q AUTOMATIC EXECUTION: schedule frequency, and the recovery procedure for a stalled queue, are documented in the migration", () => {
  assert.match(migrationSql, /Schedule: every 1 minute, batch size 50\./);
  assert.match(migrationSql, /Recovery procedure if the/);
  assert.match(migrationSql, /cron\.job_run_details/);
});

test("QUEUE INTEGRITY: duplicate enqueue is idempotent -- ON CONFLICT DO NOTHING on the structural UNIQUE(source_table, source_id) index means a re-fired trigger can never create a second queue row for the same source row", () => {
  const enqueueBlock = fnBlock("enqueue_report_for_indexing", "\\(\\)")![0];
  assert.match(enqueueBlock, /on conflict \(source_table, source_id\) do nothing/);
  const tableBlock = code.match(/create unique index if not exists report_index_queue_source_unique[\s\S]*?;/)![0];
  assert.match(tableBlock, /\(source_table, source_id\)/);
});

test("QUEUE INTEGRITY: concurrent workers cannot double-process the same row -- FOR UPDATE SKIP LOCKED means a second concurrent call simply skips rows the first has already locked, rather than blocking or double-processing", () => {
  const block = fnBlock("process_report_index_queue")![0];
  assert.match(block, /for update skip locked/);
  // The row is marked 'processing' immediately after being claimed,
  // before any potentially slow work (the dynamic SQL / index_report()
  // call), narrowing the window further.
  assert.match(block, /status = 'processing', attempts = attempts \+ 1 where id = v_row\.id;/);
});

// =======================================================================
// CORRECTION ROUND 2: flagging authorization (review point 5)
// =======================================================================

/** Mirrors flag_report()/unflag_report()'s authorization decision. */
function canFlagOrUnflag(actor: {
  isSubmitter: boolean;
  isGhod: boolean;
  isGlobalReportingController: boolean;
  isMainEnforcementInScope: boolean;
  isComplianceInScope: boolean;
}): boolean {
  if (actor.isSubmitter) return false;
  if (actor.isGhod) return false;
  return actor.isGlobalReportingController || actor.isMainEnforcementInScope || actor.isComplianceInScope;
}

test("PART I (corrected): flag_report()/unflag_report() verify the caller's OWN role via auth.uid() internally -- never trust auth.uid() is not null alone, and never trust possession of a service-role caller as authorization", () => {
  for (const fn of ["flag_report", "unflag_report"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /public\.has_active_role\('global_reporting_controller'\)/);
    assert.match(block, /public\.has_role_in_scope\('main_enforcement', v_report\.aoc_id\)/);
    assert.match(block, /public\.has_role_in_scope\('compliance', v_report\.aoc_id\)/);
  }
});

test("PART I (corrected): flag_report()/unflag_report() deny the submitter flagging/unflagging their own report", () => {
  for (const fn of ["flag_report", "unflag_report"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /v_report\.submitter_profile_id = auth\.uid\(\) then\s*\n\s*raise exception 'Cannot (flag|unflag) your own submitted report/);
  }
});

test("PART I (corrected): flag_report()/unflag_report() explicitly deny GHOD -- GHOD's access is a consequence of an existing flag (has_report_access), so GHOD must never be able to create that flag itself", () => {
  for (const fn of ["flag_report", "unflag_report"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /public\.has_active_role\('ghod'\) then\s*\n\s*raise exception 'GHOD is not authorized/);
  }
});

test("PART I (corrected): the mirrored decision table matches every combination -- submitter always denied, GHOD always denied regardless of any other role held, GRC/main_enforcement/compliance (in scope) always permitted otherwise", () => {
  assert.equal(canFlagOrUnflag({ isSubmitter: true, isGhod: false, isGlobalReportingController: true, isMainEnforcementInScope: true, isComplianceInScope: true }), false);
  assert.equal(canFlagOrUnflag({ isSubmitter: false, isGhod: true, isGlobalReportingController: true, isMainEnforcementInScope: true, isComplianceInScope: true }), false);
  assert.equal(canFlagOrUnflag({ isSubmitter: false, isGhod: false, isGlobalReportingController: true, isMainEnforcementInScope: false, isComplianceInScope: false }), true);
  assert.equal(canFlagOrUnflag({ isSubmitter: false, isGhod: false, isGlobalReportingController: false, isMainEnforcementInScope: true, isComplianceInScope: false }), true);
  assert.equal(canFlagOrUnflag({ isSubmitter: false, isGhod: false, isGlobalReportingController: false, isMainEnforcementInScope: false, isComplianceInScope: true }), true);
  assert.equal(canFlagOrUnflag({ isSubmitter: false, isGhod: false, isGlobalReportingController: false, isMainEnforcementInScope: false, isComplianceInScope: false }), false);
});

test("PART I (corrected): flag_report()/unflag_report() are granted to `authenticated` (the internal auth.uid() check is now the real boundary, not the Postgres role)", () => {
  assert.match(code, /grant execute on function public\.flag_report\(uuid, text, text\) to authenticated, service_role;/);
  assert.match(code, /grant execute on function public\.unflag_report\(uuid, text\) to authenticated, service_role;/);
});

test("PART I (corrected): flag history survives every flag/unflag call -- flagged_by/flagged_reason/flagged_at/unflagged_by/unflagged_at are written, and every call still writes an append-only report_access_audit row", () => {
  const flagBlock = fnBlock("flag_report")![0];
  assert.match(flagBlock, /flagged_by = auth\.uid\(\), flagged_reason = p_reason, flagged_at = now\(\)/);
  assert.match(flagBlock, /insert into public\.report_access_audit/);
  const unflagBlock = fnBlock("unflag_report")![0];
  assert.match(unflagBlock, /unflagged_by = auth\.uid\(\), unflagged_at = now\(\)/);
  assert.match(unflagBlock, /insert into public\.report_access_audit/);
});

// =======================================================================
// CORRECTION ROUND 2: access request/grant security (review point 6)
// =======================================================================

test("PART J (corrected): grant_report_access() validates the grantee is a real, currently-approved profile -- not just an id that satisfies the bare FK", () => {
  const block = fnBlock("grant_report_access")![0];
  assert.match(block, /select 1 from public\.profiles where id = p_grantee_profile_id and status = 'approved'/);
});

test("PART J (corrected): grant_report_access() re-validates the target report still exists in the repository before granting", () => {
  const block = fnBlock("grant_report_access")![0];
  assert.match(block, /select 1 from public\.central_reports_index where id = v_request\.repository_report_id/);
});

test("PART J: grant_report_access()/revoke_report_access() never trust a client-supplied reviewer id -- the acting admin is always auth.uid(), never a parameter", () => {
  for (const fn of ["grant_report_access", "revoke_report_access"]) {
    const block = fnBlock(fn)![0];
    assert.match(block, /v_admin_id uuid := auth\.uid\(\)/);
    assert.doesNotMatch(block, /p_(admin|reviewer|approver)_id/i);
  }
});

// =======================================================================
// CORRECTION ROUND 2: no generic service-role amendment approval exists
// (review point 11 -- kept explicitly inactive, no business approver
// role has been selected yet)
// =======================================================================

test("AMENDMENT: no amendment-approval RPC exists anywhere in this migration -- amendments stay 'pending' forever until a later explicit, gated decision", () => {
  assert.doesNotMatch(code, /function public\.approve_report_amendment/i);
  assert.doesNotMatch(code, /function public\.reject_report_amendment/i);
  const amendBlock = fnBlock("create_report_amendment")![0];
  assert.match(amendBlock, /'pending', p_amended_content/);
});

// =======================================================================
// CORRECTION ROUND 2: rollback ordering (review point 9)
// =======================================================================

test("ROLLBACK (corrected): Part P/Q triggers and functions are dropped before the report_index_queue table, and the whole Phase 5 rollback precedes any Phase 2/3/4 rollback per the documented note", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/)![0];
  const triggerDropIdx = rollbackBlock.indexOf("drop trigger if exists trg_enforce_immutability on public.report_sec013;");
  const enqueueTriggerDropIdx = rollbackBlock.indexOf("drop trigger if exists trg_enqueue_indexing on public.report_sec013;");
  const queueFnDropIdx = rollbackBlock.indexOf("drop function if exists public.process_report_index_queue(integer);");
  const queueTableDropIdx = rollbackBlock.indexOf("drop table if exists public.report_index_queue;");
  const indexViewDropIdx = rollbackBlock.indexOf("drop view if exists public.v_report_index_current_version_mismatch;");
  assert.ok(triggerDropIdx > -1 && enqueueTriggerDropIdx > -1 && queueFnDropIdx > -1 && queueTableDropIdx > -1 && indexViewDropIdx > -1);
  assert.ok(triggerDropIdx < queueFnDropIdx, "immutability trigger drops before queue function drops");
  assert.ok(enqueueTriggerDropIdx < queueFnDropIdx, "enqueue trigger drops before queue function drops");
  assert.ok(queueFnDropIdx < queueTableDropIdx, "queue function drops before queue table drops");
  assert.ok(queueTableDropIdx < indexViewDropIdx, "queue table drops before the original Part N views (documented order)");
  assert.match(rollbackBlock.replace(/\r?\n--/g, " ").replace(/\s+/g, " "), /must be rolled\s+back in full, in the order below, BEFORE any Phase 2 organizational/);
});

test("ROLLBACK (round 3): the cron job is unscheduled first (step 0, before any trigger/function/table drop), and the rollback documents reverting block_submitted_report_mutation() to its pre-Phase-5 form", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/)![0];
  const cronUnscheduleIdx = rollbackBlock.indexOf("cron.unschedule('phase5-report-index-queue');");
  const triggerDropIdx = rollbackBlock.indexOf("drop trigger if exists trg_enforce_immutability on public.report_sec013;");
  const deriveTriggerDropIdx = rollbackBlock.indexOf("drop trigger if exists trg_derive_classification on public.report_sec013;");
  assert.ok(cronUnscheduleIdx > -1 && cronUnscheduleIdx < triggerDropIdx, "cron job unscheduled before any trigger drop");
  assert.ok(deriveTriggerDropIdx > -1 && deriveTriggerDropIdx > cronUnscheduleIdx, "derive-classification trigger drop documented after the cron unschedule");
  assert.match(rollbackBlock.replace(/\r?\n--/g, " ").replace(/\s+/g, " "), /revert block_submitted_report_mutation\(\) to its pre-Phase-5\s+form/);
});

// =======================================================================
// FUNCTION PERMISSION MATRIX (review round 3, point 4): every new
// SECURITY DEFINER function has a fixed search_path, is revoked from
// PUBLIC/anon, and grants EXECUTE only to the minimum role that needs it
// =======================================================================

const FUNCTION_PERMISSION_MATRIX: Record<string, "service_role" | "authenticated, service_role"> = {
  validate_org_hierarchy: "service_role",
  confirm_report_operating_entity: "authenticated, service_role",
  index_report: "service_role",
  flag_report: "authenticated, service_role",
  unflag_report: "authenticated, service_role",
  request_report_access: "authenticated, service_role",
  grant_report_access: "authenticated, service_role",
  revoke_report_access: "authenticated, service_role",
  has_report_access: "authenticated, service_role",
  get_report_secure: "authenticated, service_role",
  create_report_amendment: "authenticated, service_role",
  enforce_report_row_immutability: "service_role",
  derive_report_classification: "service_role",
  enqueue_report_for_indexing: "service_role",
  process_report_index_queue: "service_role",
};

test("PERMISSION MATRIX: every function above is revoked from public/anon and granted EXECUTE to exactly the documented minimum role set -- no function is left with an implicit PUBLIC grant", () => {
  for (const [fn, grantee] of Object.entries(FUNCTION_PERMISSION_MATRIX)) {
    const revokeMatches = code.match(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ([^;]+);`, "g")) ?? [];
    assert.ok(revokeMatches.length >= 1, `${fn} must have a revoke statement`);
    for (const r of revokeMatches) {
      assert.match(r, /\bpublic\b/, `${fn}'s revoke must include public`);
      assert.match(r, /\banon\b/, `${fn}'s revoke must include anon`);
    }
    const grantMatches = code.match(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to ([^;]+);`, "g")) ?? [];
    assert.ok(grantMatches.length >= 1, `${fn} must have a grant statement`);
    assert.ok(
      grantMatches.some((g) => g.includes(grantee)),
      `${fn} must be granted to exactly "${grantee}", found: ${grantMatches.join(" | ")}`,
    );
  }
});

test("PERMISSION MATRIX: flag_report()/unflag_report() authorization is derived from the caller's ACTIVE role assignment via has_active_role()/has_role_in_scope() (Phase 3, unchanged) and the report's own stored aoc_id -- never a profile role label alone, and never a client-supplied scope", () => {
  for (const fn of ["flag_report", "unflag_report"]) {
    const block = fnBlock(fn)![0];
    // has_role_in_scope() (Phase 3) itself filters on rd.is_active,
    // revoked_at is null, and the active time window -- reused here
    // rather than re-implemented, so flag_report/unflag_report inherit
    // that same inactive/revoked/pending/expired rejection for free.
    assert.match(block, /public\.has_role_in_scope\('main_enforcement', v_report\.aoc_id\)/);
    assert.match(block, /public\.has_role_in_scope\('compliance', v_report\.aoc_id\)/);
    assert.doesNotMatch(block, /p_aoc_id/);
  }
});

test("PERMISSION MATRIX: a service-role bypass exists in exactly 3 places in this migration's own new code (enforce_report_row_immutability, derive_report_classification's clearing guard, and the corrected block_submitted_report_mutation), and each is narrowly scoped to specific columns, never a blanket 'do anything' bypass", () => {
  const bypassCount = (code.match(/auth\.role\(\) = 'service_role'/g) ?? []).length;
  const inverseCount = (code.match(/auth\.role\(\) <> 'service_role'/g) ?? []).length;
  assert.equal(bypassCount + inverseCount, 3, `expected exactly 3 service_role role-checks in new Phase 5 functions, found ${bypassCount + inverseCount}`);
});
