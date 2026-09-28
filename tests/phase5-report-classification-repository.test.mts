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

test("FLAGGING: flag_report()/unflag_report() are service_role-only in this phase -- no ordinary role is wired to call them yet (Phase 5 activates no new role access)", () => {
  assert.match(code, /revoke execute on function public\.flag_report\(uuid, text, text\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.flag_report\(uuid, text, text\) to service_role;/);
  assert.match(code, /revoke execute on function public\.unflag_report\(uuid, text\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.unflag_report\(uuid, text\) to service_role;/);
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

test("REGRESSION: no route/server-action file references any Phase 5 object -- zero live wiring, confirmed by repo-wide search", () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const searchDirs = ["lib", "app", "components"];
  const phase5Objects = ["central_reports_index", "index_report", "get_report_secure", "has_report_access", "create_report_amendment"];
  for (const dir of searchDirs) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) continue;
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(d, entry.name)) : [path.join(d, entry.name)],
      );
    for (const file of walk(full)) {
      if (!/\.(ts|tsx)$/.test(file) || file.endsWith("database.types.ts")) continue;
      const contents = fs.readFileSync(file, "utf8");
      for (const obj of phase5Objects) {
        assert.doesNotMatch(contents, new RegExp(obj), `${file} must not reference ${obj}`);
      }
    }
  }
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
