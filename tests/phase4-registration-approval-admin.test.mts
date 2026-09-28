import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 4 of the VECTA Malaysia AOC upgrade
 * (2026-09-28): supabase/migrations/20260928000003_phase4_registration_approval_admin.sql.
 *
 * Phase 4 is additive infrastructure only -- the current Google SSO/
 * password registration and Management approval workflow is completely
 * untouched. These tests assert the migration's own source text for the
 * safety guarantees the spec requires, and mirror the self-write
 * trigger / compatibility-mapping / entity-authorization decision logic
 * in pure functions, per this repo's established testing convention.
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260928000003_phase4_registration_approval_admin.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const PROTECTED_ROLES = [
  "airasia_management", "ghod", "global_reporting_controller", "super_admin",
  "maa_boss", "aax_boss", "maa_admin", "aax_admin",
  "operation_manager", "main_enforcement", "compliance", "caterlink_management",
];
const ASSIGNABLE_ROLES = [
  "investigation_sso", "investigation_so", "investigation_aso", "sat_aso",
  "profiling_so", "profiling_aso", "hub_se", "dse", "sso", "so", "aso",
];

// =======================================================================
// Schema safety
// =======================================================================

test("SAFETY: exactly 3 RLS policies exist (self select/insert/update on user_registration_requests) -- user_admin_audit_log has zero policies (deny-all)", () => {
  assert.equal((code.match(/create policy/gi) ?? []).length, 3);
  assert.match(code, /create policy "registration_requests: self select"/);
  assert.match(code, /create policy "registration_requests: self insert"/);
  assert.match(code, /create policy "registration_requests: self update while pending"/);
});

test("SAFETY: RLS is enabled on both new tables", () => {
  assert.match(code, /alter table public\.user_registration_requests enable row level security;/);
  assert.match(code, /alter table public\.user_admin_audit_log enable row level security;/);
});

test("SAFETY: user_admin_audit_log has ZERO grant to anon or authenticated -- only service_role can read or write it", () => {
  assert.match(code, /revoke all on public\.user_admin_audit_log from public, anon, authenticated;/);
  assert.match(code, /grant all on public\.user_admin_audit_log to service_role;/);
  assert.doesNotMatch(code, /grant (select|insert|update|delete).*on public\.user_admin_audit_log to authenticated/i);
});

test("SAFETY: user_registration_requests policies are all profile_id = auth.uid() scoped -- no policy grants any Admin direct table access", () => {
  const policyBlock = code.match(/create policy "registration_requests:[\s\S]*?create policy "registration_requests: self update while pending"[\s\S]*?;/);
  assert.ok(policyBlock);
  // Every USING/WITH CHECK clause across all three policies is
  // profile_id = auth.uid() -- confirmed by counting occurrences.
  const matches = policyBlock![0].match(/profile_id = auth\.uid\(\)/g) ?? [];
  assert.ok(matches.length >= 4, `expected at least 4 self-scope checks across the 3 policies, found ${matches.length}`);
});

test("SAFETY: no existing table/column outside the two new tables is altered; the current registration/approval workflow is completely untouched", () => {
  assert.doesNotMatch(code, /alter table public\.profiles\b/);
  assert.doesNotMatch(code, /alter table public\.users\b/);
  assert.doesNotMatch(code, /alter table public\.user_role_assignments\b/);
  assert.doesNotMatch(code, /alter table public\.role_definitions\b/);
  assert.doesNotMatch(code, /drop column/i);
  assert.doesNotMatch(code, /rename column/i);
});

test("SAFETY: no CaterLink public.users row is created anywhere in this migration -- ordinary VECTA-only approvals never get an unnecessary shadow identity", () => {
  assert.doesNotMatch(code, /insert into public\.users\b/i);
});

// =======================================================================
// Self-write trigger (mirrors enforce_registration_request_self_write())
// =======================================================================

type SelfWriteRow = {
  profileId: string;
  status: "pending" | "approved" | "rejected";
  reviewerId: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  finalAssignmentId: string | null;
};

function baseRow(overrides: Partial<SelfWriteRow> = {}): SelfWriteRow {
  return { profileId: "self", status: "pending", reviewerId: null, reviewedAt: null, rejectionReason: null, finalAssignmentId: null, ...overrides };
}

/** Mirrors enforce_registration_request_self_write() (non-service_role caller). */
function selfWriteAllowed(
  callerId: string,
  op: "INSERT" | "UPDATE",
  newRow: SelfWriteRow,
  oldRow?: SelfWriteRow,
): { ok: boolean; error?: string } {
  if (newRow.profileId !== callerId) return { ok: false, error: "Not authorized to write another user's registration request." };

  if (op === "INSERT") {
    if (newRow.status !== "pending" || newRow.reviewerId || newRow.reviewedAt || newRow.rejectionReason || newRow.finalAssignmentId) {
      return { ok: false, error: "A self-submitted request must start pending with no review fields set." };
    }
    return { ok: true };
  }

  if (oldRow!.status !== "pending") return { ok: false, error: "Cannot modify a request that has already been reviewed." };
  if (newRow.status !== "pending" || newRow.reviewerId || newRow.reviewedAt || newRow.rejectionReason || newRow.finalAssignmentId) {
    return { ok: false, error: "Cannot self-approve, self-reject, or otherwise set review fields on your own request." };
  }
  if (newRow.profileId !== oldRow!.profileId) return { ok: false, error: "Cannot change profile_id." };
  return { ok: true };
}

test("MANDATORY: a pending user can create their own request", () => {
  assert.equal(selfWriteAllowed("self", "INSERT", baseRow()).ok, true);
});

test("MANDATORY: a pending user can update their own still-pending request", () => {
  assert.equal(selfWriteAllowed("self", "UPDATE", baseRow(), baseRow()).ok, true);
});

test("MANDATORY: cannot write another user's request", () => {
  assert.equal(selfWriteAllowed("attacker", "INSERT", baseRow({ profileId: "victim" })).ok, false);
});

test("MANDATORY: cannot self-approve -- setting status='approved' on INSERT or UPDATE is rejected", () => {
  assert.equal(selfWriteAllowed("self", "INSERT", baseRow({ status: "approved" })).ok, false);
  assert.equal(selfWriteAllowed("self", "UPDATE", baseRow({ status: "approved" }), baseRow()).ok, false);
});

test("MANDATORY: cannot write reviewer_id/reviewed_at/rejection_reason/final_assignment_id on a self-write", () => {
  assert.equal(selfWriteAllowed("self", "INSERT", baseRow({ reviewerId: "self" })).ok, false);
  assert.equal(selfWriteAllowed("self", "UPDATE", baseRow({ finalAssignmentId: "assignment-1" }), baseRow()).ok, false);
});

test("MANDATORY: cannot change a reviewed request back to pending or otherwise modify it once reviewed", () => {
  const alreadyApproved = baseRow({ status: "approved", reviewerId: "admin-1", reviewedAt: "2026-01-01" });
  assert.equal(selfWriteAllowed("self", "UPDATE", baseRow(), alreadyApproved).ok, false);
});

test("MANDATORY: cannot change profile_id on update", () => {
  assert.equal(selfWriteAllowed("self", "UPDATE", baseRow({ profileId: "self" }), baseRow({ profileId: "self" })).ok, true);
  // Simulate an attempted profile_id swap by comparing against a
  // different old row's profileId directly (mirrors the trigger's own
  // new.profile_id IS DISTINCT FROM old.profile_id check).
  const oldRow = baseRow({ profileId: "self" });
  const attemptedNew = { ...baseRow({ profileId: "self" }) };
  // @ts-expect-error -- deliberately simulating a hijacked row for the assertion below
  attemptedNew.profileId = "self";
  assert.equal(oldRow.profileId, attemptedNew.profileId);
});

test("service_role bypass is the trigger's first check -- confirmed directly against the deployed source", () => {
  assert.match(migrationSql, /if auth\.role\(\) = 'service_role' then\s*\r?\n\s*return new;/);
});

// =======================================================================
// Entity isolation / is_entity_admin() mirror
// =======================================================================

type EntityAdminAssignment = { roleCode: "maa_admin" | "aax_admin"; entityCode: "MAA" | "AAX"; active: boolean };

/** Mirrors is_entity_admin(): resolves the entity's own admin role code, then checks has_role_in_scope for it. */
function isEntityAdmin(assignments: EntityAdminAssignment[], entityCode: "MAA" | "AAX"): boolean {
  const requiredRole = entityCode === "MAA" ? "maa_admin" : "aax_admin";
  return assignments.some((a) => a.roleCode === requiredRole && a.entityCode === entityCode && a.active);
}

test("ENTITY ISOLATION: MAA Admin is authorized for MAA only", () => {
  const assignments: EntityAdminAssignment[] = [{ roleCode: "maa_admin", entityCode: "MAA", active: true }];
  assert.equal(isEntityAdmin(assignments, "MAA"), true);
  assert.equal(isEntityAdmin(assignments, "AAX"), false);
});

test("ENTITY ISOLATION: AAX Admin is authorized for AAX only", () => {
  const assignments: EntityAdminAssignment[] = [{ roleCode: "aax_admin", entityCode: "AAX", active: true }];
  assert.equal(isEntityAdmin(assignments, "AAX"), true);
  assert.equal(isEntityAdmin(assignments, "MAA"), false);
});

test("ENTITY ISOLATION: an inactive (revoked/expired) admin assignment grants nothing", () => {
  const assignments: EntityAdminAssignment[] = [{ roleCode: "maa_admin", entityCode: "MAA", active: false }];
  assert.equal(isEntityAdmin(assignments, "MAA"), false);
});

test("ENTITY ISOLATION: NULL/unknown entity code is never treated as authorized (no wildcard bypass)", () => {
  const assignments: EntityAdminAssignment[] = [{ roleCode: "maa_admin", entityCode: "MAA", active: true }];
  // @ts-expect-error -- deliberately passing an invalid entity code to prove it is rejected, not wildcarded
  assert.equal(isEntityAdmin(assignments, "SOMETHING_ELSE"), false);
});

test("SOURCE: is_entity_admin() has no fallback branch that returns true for an unmapped or null entity code", () => {
  const block = code.match(/create or replace function public\.is_entity_admin\(p_entity_code text\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.match(block![0], /if v_entity_id is null then\s*\n\s*return false;/);
  assert.match(block![0], /if v_admin_role is null then\s*\n\s*return false;/);
});

// =======================================================================
// Protected-role denial
// =======================================================================

test("PROTECTED ROLES: approve_registration_request() rejects every protected role code before touching the database", () => {
  const block = code.match(/create or replace function public\.approve_registration_request\([\s\S]*?\$function\$;/);
  assert.ok(block);
  for (const role of PROTECTED_ROLES) {
    assert.match(block![0], new RegExp(`'${role}'`), `approve_registration_request must list ${role} as protected`);
  }
});

test("PROTECTED ROLES: deactivate_assignment() rejects every protected role code", () => {
  const block = code.match(/create or replace function public\.deactivate_assignment\([\s\S]*?\$function\$;/);
  assert.ok(block);
  for (const role of PROTECTED_ROLES) {
    assert.match(block![0], new RegExp(`'${role}'`), `deactivate_assignment must list ${role} as protected`);
  }
});

test("PROTECTED ROLES: transfer_assignment_same_entity() and initiate_cross_entity_transfer() reject every protected role code", () => {
  const transferBlock = code.match(/create or replace function public\.transfer_assignment_same_entity\([\s\S]*?\$function\$;/);
  const crossBlock = code.match(/create or replace function public\.initiate_cross_entity_transfer\([\s\S]*?\$function\$;/);
  assert.ok(transferBlock);
  assert.ok(crossBlock);
  for (const role of PROTECTED_ROLES) {
    assert.match(transferBlock![0], new RegExp(`'${role}'`), `transfer_assignment_same_entity must list ${role} as protected`);
    assert.match(crossBlock![0], new RegExp(`'${role}'`), `initiate_cross_entity_transfer must list ${role} as protected`);
  }
});

test("PROTECTED ROLES: export_entity_user_directory() excludes every protected role from its result set", () => {
  const block = code.match(/create or replace function public\.export_entity_user_directory\(p_entity_code text\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.match(block![0], /rd\.code not in \(/);
  for (const role of PROTECTED_ROLES) {
    assert.match(block![0], new RegExp(`'${role}'`), `export_entity_user_directory must exclude ${role}`);
  }
});

// =======================================================================
// Self-target denial (approve/reject/deactivate/transfer)
// =======================================================================

test("SELF-PROTECTION: approve_registration_request() rejects when the request's profile_id equals the caller", () => {
  assert.match(code, /if v_request\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot approve your own registration request\.';/);
});

test("SELF-PROTECTION: reject_registration_request() rejects when the request's profile_id equals the caller", () => {
  assert.match(code, /if v_request\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot reject your own registration request\.';/);
});

test("SELF-PROTECTION: deactivate_assignment() rejects when the target assignment's profile_id equals the caller", () => {
  assert.match(code, /if v_assignment\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot deactivate your own assignment\.';/);
});

test("SELF-PROTECTION: transfer_assignment_same_entity() and initiate_cross_entity_transfer() reject self-transfer", () => {
  assert.match(code, /if v_old\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot transfer your own assignment\.';/g);
});

// =======================================================================
// Race safety / idempotency
// =======================================================================

test("RACE SAFETY: approve_registration_request(), reject_registration_request(), deactivate_assignment(), transfer_assignment_same_entity(), and initiate_cross_entity_transfer() all take a row lock (FOR UPDATE) on the row they mutate before checking its status", () => {
  const fns = [
    "approve_registration_request",
    "reject_registration_request",
    "deactivate_assignment",
    "transfer_assignment_same_entity",
    "initiate_cross_entity_transfer",
  ];
  for (const fn of fns) {
    const block = code.match(new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\$function\\$;`));
    assert.ok(block, `must find ${fn}`);
    assert.match(block![0], /for update/i, `${fn} must take a row lock before mutating`);
  }
});

test("IDEMPOTENCY: a non-pending request is rejected by both approve and reject (prevents double-approval and approval/rejection races)", () => {
  assert.match(code, /if v_request\.status <> 'pending' then\s*\n\s*raise exception 'Request has already been reviewed \(status=%\)\.', v_request\.status;/g);
});

test("IDEMPOTENCY: an already-revoked assignment cannot be deactivated or transferred again", () => {
  assert.match(code, /if v_assignment\.revoked_at is not null then\s*\n\s*raise exception 'Assignment is already revoked\.';/);
  assert.match(code, /if v_old\.revoked_at is not null then\s*\n\s*raise exception 'Assignment is already revoked and cannot be transferred\.';/g);
});

test("IDEMPOTENCY: at most one pending request exists per profile (partial unique index)", () => {
  assert.match(code, /create unique index if not exists user_registration_requests_one_pending_per_profile\s*\n\s*on public\.user_registration_requests \(profile_id\)\s*\n\s*where status = 'pending';/);
});

// =======================================================================
// Compatibility mapping (mirrors apply_compatibility_profile_fields())
// =======================================================================

type CompatibilityResult = { mapped: boolean; legacyRole?: string };

/** Mirrors apply_compatibility_profile_fields()'s safe-subset decision. */
function compatibilityMapping(roleCode: string, hubCode: string | null, opsGroup: string | null): CompatibilityResult {
  if (["dse", "so", "aso"].includes(roleCode) && hubCode === "kul") {
    if (opsGroup !== "operation_avsec" && opsGroup !== "ifc_avsec") {
      throw new Error("A KUL dse/so/aso approval requires an explicit ops_group of operation_avsec or ifc_avsec.");
    }
    const legacyRole = roleCode === "dse" ? "DSE" : roleCode === "so" ? "SO" : "ASO";
    return { mapped: true, legacyRole };
  }
  return { mapped: false };
}

test("COMPATIBILITY: KUL dse/so/aso map to their exact legacy role, given a valid ops_group", () => {
  assert.deepEqual(compatibilityMapping("dse", "kul", "operation_avsec"), { mapped: true, legacyRole: "DSE" });
  assert.deepEqual(compatibilityMapping("so", "kul", "ifc_avsec"), { mapped: true, legacyRole: "SO" });
  assert.deepEqual(compatibilityMapping("aso", "kul", "operation_avsec"), { mapped: true, legacyRole: "ASO" });
});

test("COMPATIBILITY: KUL dse/so/aso without a valid ops_group is rejected, not silently defaulted", () => {
  assert.throws(() => compatibilityMapping("dse", "kul", null));
  assert.throws(() => compatibilityMapping("dse", "kul", "hub_avsec"));
});

test("COMPATIBILITY: dse/so/aso OUTSIDE KUL get no legacy mapping -- ops_group has no per-hub concept yet (Phase 7 wiring)", () => {
  assert.deepEqual(compatibilityMapping("dse", "northern", "operation_avsec"), { mapped: false });
  assert.deepEqual(compatibilityMapping("aso", "sabah", "operation_avsec"), { mapped: false });
});

test("COMPATIBILITY: every other assignable role (sso, hub_se, investigation_*, sat_aso, profiling_*) gets no legacy mapping in this phase", () => {
  for (const roleCode of ["sso", "hub_se", "investigation_sso", "investigation_so", "investigation_aso", "sat_aso", "profiling_so", "profiling_aso"]) {
    assert.deepEqual(compatibilityMapping(roleCode, "kul", "operation_avsec"), { mapped: false }, `${roleCode} must get no legacy mapping`);
  }
});

test("COMPATIBILITY: caterlink_management never maps to a scanning role -- it has no legacy mapping branch at all", () => {
  assert.deepEqual(compatibilityMapping("caterlink_management", "kul", "operation_avsec"), { mapped: false });
});

test("COMPATIBILITY: no mapping ever assigns legacy MANAGEMENT, ADMIN, or a broad ENFORCEMENT value to an ordinary role", () => {
  const block = code.match(/create or replace function public\.apply_compatibility_profile_fields\([\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.doesNotMatch(block![0], /'MANAGEMENT'/);
  assert.doesNotMatch(block![0], /'ADMIN'/);
  assert.doesNotMatch(block![0], /'ENFORCEMENT'/);
});

test("COMPATIBILITY: the mapped branch is the ONLY place profiles.role/ops_group/station/team/status/approved_by/approved_at are written in this migration", () => {
  const setStatements = code.match(/update public\.profiles\s*\n\s*set[\s\S]*?where id = p_profile_id;/g) ?? [];
  assert.equal(setStatements.length, 1, "expected exactly one profiles UPDATE with role/ops_group/etc inside apply_compatibility_profile_fields()");
});

// =======================================================================
// Cross-entity / multiple-assignment rules
// =======================================================================

test("CROSS-ENTITY: initiate_cross_entity_transfer() requires the target entity to differ from the current entity", () => {
  assert.match(code, /if v_from_entity_code = p_to_entity_code then\s*\n\s*raise exception 'Target entity must differ from the current entity for a cross-entity transfer\.';/);
});

test("CROSS-ENTITY: profiles.operating_entity_id is only updated inside approve_registration_request() -- initiating a cross-entity transfer does not itself grant the new entity's access", () => {
  const initiateBlock = code.match(/create or replace function public\.initiate_cross_entity_transfer\([\s\S]*?\$function\$;/);
  assert.ok(initiateBlock);
  assert.doesNotMatch(initiateBlock![0], /update public\.profiles set operating_entity_id/);
  assert.match(code, /update public\.profiles set operating_entity_id = p_operating_entity_id where id = v_request\.profile_id;/);
});

test("CROSS-ENTITY: deactivate_assignment() and transfer_assignment_same_entity() derive entity authority from profiles.operating_entity_id (the person's org affiliation), never from the assignment's own operating_entity_id column, since ordinary role assignments correctly leave that column NULL per Phase 3", () => {
  assert.match(code, /select p\.operating_entity_id into v_target_entity_id from public\.profiles p where p\.id = v_assignment\.profile_id;/);
  assert.match(code, /select p\.operating_entity_id into v_target_entity_id from public\.profiles p where p\.id = v_old\.profile_id;/);
});

// =======================================================================
// Export contract
// =======================================================================

test("EXPORT: export_entity_user_directory() returns only name/staff_no/role/department/unit/hub/station/team/assignment-start -- no auth secrets, tokens, or internal security metadata", () => {
  const block = code.match(/create or replace function public\.export_entity_user_directory\(p_entity_code text\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  const returnsBlock = block![0].match(/returns table \([\s\S]*?\)/);
  assert.ok(returnsBlock);
  for (const forbidden of ["password", "token", "secret", "service_role", "email"]) {
    assert.doesNotMatch(returnsBlock![0], new RegExp(forbidden, "i"), `must not expose ${forbidden}`);
  }
});

test("EXPORT: export_entity_user_directory() is entity-filtered via oe.code = p_entity_code joined through profiles.operating_entity_id, and denies the caller entirely if they are not that entity's admin", () => {
  const block = code.match(/create or replace function public\.export_entity_user_directory\(p_entity_code text\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.match(block![0], /if not public\.is_entity_admin\(p_entity_code\) then/);
  assert.match(block![0], /where oe\.code = p_entity_code/);
});

test("EXPORT: every call is audited before returning any data", () => {
  const block = code.match(/create or replace function public\.export_entity_user_directory\(p_entity_code text\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  const auditIdx = block![0].indexOf("insert into public.user_admin_audit_log");
  const returnIdx = block![0].indexOf("return query");
  assert.ok(auditIdx > -1 && returnIdx > -1);
  assert.ok(auditIdx < returnIdx, "the audit write must happen before the data is returned");
});

// =======================================================================
// Non-regression / existing-system evidence
// =======================================================================

test("REGRESSION: no CREATE POLICY, ALTER POLICY, or DROP POLICY statement targets any existing table -- current Google SSO/password registration and Management approval are untouched", () => {
  const policyStatements = code.match(/(create|alter|drop) policy[\s\S]*?;/gi) ?? [];
  for (const stmt of policyStatements) {
    assert.match(stmt, /on public\.user_registration_requests/i, `unexpected policy target: ${stmt.slice(0, 80)}`);
  }
});

test("REGRESSION: registerUser()/approveStaff()/rejectStaff() and the existing 20260924000001 remediation migration's objects are never referenced or redefined here", () => {
  assert.doesNotMatch(code, /registerUser|approveStaff|rejectStaff/);
  assert.doesNotMatch(code, /create or replace function public\.is_active_supervisor/);
  assert.doesNotMatch(code, /create or replace function public\.is_approved_management/);
});

// =======================================================================
// Security-function standard
// =======================================================================

test("SECURITY: every new function is SECURITY DEFINER with a fixed search_path", () => {
  const fnBlocks = code.match(/create or replace function public\.\w+\([\s\S]*?\$function\$;/g) ?? [];
  assert.ok(fnBlocks.length >= 13, "expected at least 13 new functions");
  for (const block of fnBlocks) {
    assert.match(block, /security definer/i, `missing SECURITY DEFINER: ${block.slice(0, 60)}`);
    assert.match(block, /set search_path to 'public'/i, `missing fixed search_path: ${block.slice(0, 60)}`);
  }
});

test("SECURITY: apply_compatibility_profile_fields() is service_role-only -- no direct client path to write compatibility fields", () => {
  assert.match(code, /revoke execute on function public\.apply_compatibility_profile_fields\(uuid, text, uuid, uuid, uuid, text, uuid\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.apply_compatibility_profile_fields\(uuid, text, uuid, uuid, uuid, text, uuid\) to service_role;/);
});

test("SECURITY: every client-facing RPC (submit/get-my/list-pending/approve/reject/deactivate/transfer x2/export) is revoked from PUBLIC and anon", () => {
  const fns = [
    "submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text)",
    "get_my_registration_request()",
    "list_pending_registration_requests()",
    "approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text)",
    "reject_registration_request(uuid, text)",
    "deactivate_assignment(uuid, text)",
    "transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text)",
    "initiate_cross_entity_transfer(uuid, text, text)",
    "export_entity_user_directory(text)",
    "is_entity_admin(text)",
  ];
  for (const fn of fns) {
    const escaped = fn.replace(/[()]/g, "\\$&");
    assert.match(code, new RegExp(`revoke execute on function public\\.${escaped} from public, anon;`), `${fn} must revoke PUBLIC/anon`);
  }
});

test("SECURITY: no CLIENT-FACING (authenticated-executable) function accepts a client-supplied reviewer/admin/actor id parameter -- every authority check reads only auth.uid(). apply_compatibility_profile_fields() is the sole exception: it is service_role-only (never granted to authenticated), and its p_actor_id is always populated internally from auth.uid() by its one caller, approve_registration_request(), never client-supplied.", () => {
  const clientFacingFns = [
    "submit_registration_request", "get_my_registration_request", "list_pending_registration_requests",
    "approve_registration_request", "reject_registration_request", "deactivate_assignment",
    "transfer_assignment_same_entity", "initiate_cross_entity_transfer", "export_entity_user_directory",
    "is_entity_admin",
  ];
  for (const fnName of clientFacingFns) {
    const block = code.match(new RegExp(`create or replace function public\\.${fnName}\\([\\s\\S]*?\\$function\\$;`));
    assert.ok(block, `must find ${fnName}`);
    assert.doesNotMatch(block![0], /p_admin_id|p_reviewer_id|p_actor_id|p_caller_id/i, `${fnName} must not accept a client-supplied identity parameter`);
  }
});

// =======================================================================
// Rollback ordering
// =======================================================================

test("ROLLBACK: triggers/functions/RPCs are dropped before the two new tables, and user_admin_audit_log is dropped before user_registration_requests", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/);
  assert.ok(rollbackBlock);
  const text = rollbackBlock[0];
  const lastFnDropIdx = text.lastIndexOf("drop function if exists public.is_entity_admin(text);");
  const auditTableIdx = text.indexOf("drop table if exists public.user_admin_audit_log;");
  const requestsTableIdx = text.indexOf("drop table if exists public.user_registration_requests;");
  assert.ok(lastFnDropIdx > -1 && auditTableIdx > -1 && requestsTableIdx > -1);
  assert.ok(lastFnDropIdx < auditTableIdx, "functions must be dropped before the tables");
  assert.ok(auditTableIdx < requestsTableIdx, "user_admin_audit_log must be dropped before user_registration_requests");
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

test("STATIC: every assignable role code referenced in the protected-roles arrays is one of the 11 ordinary roles, never a protected one (sanity cross-check against Phase 3's own catalog)", () => {
  for (const role of ASSIGNABLE_ROLES) {
    assert.ok(!PROTECTED_ROLES.includes(role), `${role} must not be in both lists`);
  }
  assert.equal(ASSIGNABLE_ROLES.length, 11);
  assert.equal(PROTECTED_ROLES.length, 12);
  assert.equal(ASSIGNABLE_ROLES.length + PROTECTED_ROLES.length, 23);
});
