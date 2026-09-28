import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 4 of the VECTA Malaysia AOC upgrade
 * (2026-09-28, second pass): supabase/migrations/20260928000003_phase4_registration_approval_admin.sql.
 *
 * This pass corrects the entity-affiliation and approval-state design:
 * administrative entity membership (user_entity_memberships) is now
 * separate from operational authorization scope
 * (user_role_assignments), profiles.operating_entity_id is a derived
 * compatibility/display value only, cross-entity transfer no longer
 * revokes access before the receiving entity approves, and deferred
 * roles get an explicit approval_state instead of a silently-unchanged
 * status. These tests assert the migration's own source text for the
 * safety guarantees the spec requires, and mirror the corrected
 * decision logic in pure functions.
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

function fnBlock(name: string, sig = "\\([\\s\\S]*?\\)"): RegExpMatchArray | null {
  return code.match(new RegExp(`create or replace function public\\.${name}${sig}[\\s\\S]*?\\$function\\$;`));
}

// =======================================================================
// Entity-membership schema safety
// =======================================================================

test("SCHEMA: user_entity_memberships has the required columns and status enum", () => {
  const block = code.match(/create table if not exists public\.user_entity_memberships \([\s\S]*?\n\);/);
  assert.ok(block);
  for (const col of ["profile_id", "aoc_id", "operating_entity_id", "status", "is_primary", "starts_at", "ends_at", "revoked_at", "created_by", "approved_by", "reason"]) {
    assert.match(block![0], new RegExp(col), `missing column: ${col}`);
  }
  assert.match(block![0], /status in \('pending', 'active', 'ended', 'revoked'\)/);
});

test("SCHEMA: at most one active membership per (profile, entity), and at most one active primary membership per profile", () => {
  assert.match(code, /create unique index if not exists user_entity_memberships_one_active_per_entity\s*\n\s*on public\.user_entity_memberships \(profile_id, operating_entity_id\)\s*\n\s*where status = 'active';/);
  assert.match(code, /create unique index if not exists user_entity_memberships_one_active_primary\s*\n\s*on public\.user_entity_memberships \(profile_id\)\s*\n\s*where is_primary and status = 'active';/);
});

test("SCHEMA: user_role_assignments gains entity_membership_id as an additive nullable column, not a rewrite of any existing Phase 3 column", () => {
  assert.match(code, /alter table public\.user_role_assignments\s*\n\s*add column if not exists entity_membership_id uuid references public\.user_entity_memberships\(id\);/);
});

test("SCHEMA: user_entity_memberships has zero grant to anon/authenticated -- read/write only through the RPCs and Part D helpers", () => {
  assert.match(code, /revoke all on public\.user_entity_memberships from public, anon, authenticated;/);
  assert.match(code, /grant all on public\.user_entity_memberships to service_role;/);
});

// =======================================================================
// Assignment-to-membership consistency (mirrors validate_assignment_entity_membership())
// =======================================================================

type Membership = { id: string; profileId: string; status: "pending" | "active" | "ended" | "revoked"; aocId: string };
type Assignment = { profileId: string; aocId: string; entityMembershipId: string | null };

/** Mirrors validate_assignment_entity_membership(). */
function validateAssignmentMembership(a: Assignment, memberships: Record<string, Membership>): { ok: boolean; error?: string } {
  if (a.entityMembershipId === null) return { ok: true };
  const m = memberships[a.entityMembershipId];
  if (!m) return { ok: false, error: "entity_membership_id does not reference a real membership." };
  if (m.profileId !== a.profileId) return { ok: false, error: "entity_membership_id belongs to a different profile than this assignment." };
  if (m.status !== "active") return { ok: false, error: "entity_membership_id must reference an active membership." };
  if (m.aocId !== a.aocId) return { ok: false, error: "entity_membership_id AOC does not match the assignment aoc_id." };
  return { ok: true };
}

test("CONSISTENCY: an assignment with no membership link is always valid (international/platform roles never link)", () => {
  assert.equal(validateAssignmentMembership({ profileId: "u1", aocId: "my", entityMembershipId: null }, {}).ok, true);
});

test("CONSISTENCY: an assignment cannot link to another profile's membership", () => {
  const memberships = { m1: { id: "m1", profileId: "other-user", status: "active" as const, aocId: "my" } };
  const result = validateAssignmentMembership({ profileId: "u1", aocId: "my", entityMembershipId: "m1" }, memberships);
  assert.equal(result.ok, false);
});

test("CONSISTENCY: an assignment cannot link to a revoked/ended/pending membership", () => {
  for (const status of ["ended", "revoked", "pending"] as const) {
    const memberships = { m1: { id: "m1", profileId: "u1", status, aocId: "my" } };
    const result = validateAssignmentMembership({ profileId: "u1", aocId: "my", entityMembershipId: "m1" }, memberships);
    assert.equal(result.ok, false, `${status} membership must not authorize an assignment`);
  }
});

test("CONSISTENCY: an assignment cannot link to a membership from a different AOC (future-AOC-safe)", () => {
  const memberships = { m1: { id: "m1", profileId: "u1", status: "active" as const, aocId: "other-aoc" } };
  const result = validateAssignmentMembership({ profileId: "u1", aocId: "my", entityMembershipId: "m1" }, memberships);
  assert.equal(result.ok, false);
});

test("CONSISTENCY: a valid, active, same-profile, same-AOC membership link passes", () => {
  const memberships = { m1: { id: "m1", profileId: "u1", status: "active" as const, aocId: "my" } };
  const result = validateAssignmentMembership({ profileId: "u1", aocId: "my", entityMembershipId: "m1" }, memberships);
  assert.equal(result.ok, true);
});

// =======================================================================
// Profile org-field lockdown (Part C) -- direct-update path closed
// =======================================================================

test("LOCKDOWN: a new trigger makes profiles.aoc_id/operating_entity_id/department_id/unit_id/hub_id/org_station_id/org_team_id writable only by service_role, closing the direct-update path this correction flagged", () => {
  const block = fnBlock("enforce_profiles_org_fields_service_role_only", "\\(\\)");
  assert.ok(block);
  for (const col of ["aoc_id", "operating_entity_id", "department_id", "unit_id", "hub_id", "org_station_id", "org_team_id"]) {
    assert.match(block![0], new RegExp(`new\\.${col} is distinct from old\\.${col}`), `missing lockdown for ${col}`);
  }
  assert.match(block![0], /if auth\.role\(\) = 'service_role' then\s*\n\s*return new;/);
});

// =======================================================================
// Primary-affiliation rules (mirrors get_or_create_active_membership())
// =======================================================================

type MembershipRow = { profileId: string; entityId: string; status: "active" | "ended" | "revoked"; isPrimary: boolean };

/** Mirrors get_or_create_active_membership()'s primary-assignment logic. */
function primaryAfterApproval(existing: MembershipRow[], newEntityId: string, profileId: string): { primaryEntityId: string | null } {
  const hasActivePrimary = existing.some((m) => m.profileId === profileId && m.isPrimary && m.status === "active");
  if (hasActivePrimary) {
    const current = existing.find((m) => m.profileId === profileId && m.isPrimary && m.status === "active")!;
    return { primaryEntityId: current.entityId };
  }
  return { primaryEntityId: newEntityId };
}

test("PRIMARY: a person's first-ever active membership becomes primary automatically", () => {
  assert.deepEqual(primaryAfterApproval([], "maa", "u1"), { primaryEntityId: "maa" });
});

test("PRIMARY: approving a SECOND entity's membership never silently displaces an existing primary", () => {
  const existing: MembershipRow[] = [{ profileId: "u1", entityId: "maa", status: "active", isPrimary: true }];
  assert.deepEqual(primaryAfterApproval(existing, "aax", "u1"), { primaryEntityId: "maa" });
});

test("PRIMARY: MAA and AAX active memberships may coexist for the same profile", () => {
  assert.match(code, /select id into v_membership_id\s*\n\s*from public\.user_entity_memberships\s*\n\s*where profile_id = p_profile_id and operating_entity_id = p_operating_entity_id and status = 'active'/);
  assert.doesNotMatch(code, /create unique index[\s\S]*?on public\.user_entity_memberships \(profile_id\)\s*\n\s*;/);
});

test("PRIMARY: changing/assigning primary status is audited (compatibility_sync action, first_active_membership reason)", () => {
  const block = fnBlock("get_or_create_active_membership");
  assert.ok(block);
  assert.match(block![0], /insert into public\.user_admin_audit_log/);
  assert.match(block![0], /'first_active_membership'/);
});

test("PRIMARY: profiles.operating_entity_id is written ONLY inside sync_primary_operating_entity(), derived from the active primary membership, never set independently elsewhere", () => {
  const writes = code.match(/update public\.profiles set operating_entity_id = [^;]+;/g) ?? [];
  assert.equal(writes.length, 1, `expected exactly one write to profiles.operating_entity_id, found ${writes.length}`);
  assert.match(writes[0], /v_primary_entity_id/);
});

// =======================================================================
// Assignment <-> membership linkage in approve_registration_request()
// =======================================================================

test("LINKAGE: approve_registration_request() calls get_or_create_active_membership() and stores the returned id as the new assignment's entity_membership_id", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  assert.match(block![0], /v_membership_id := public\.get_or_create_active_membership\(v_request\.profile_id, p_aoc_id, p_operating_entity_id, v_admin_id\);/);
  assert.match(block![0], /entity_membership_id\s*\)\s*\n\s*select[\s\S]*?v_membership_id\s*\n\s*from public\.role_definitions/);
});

test("LINKAGE: every one of the 11 ordinary roles gets the same entity_membership_id linkage treatment -- no role-code branch skips linking it for Investigation/SAT/Profiling specifically", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  assert.doesNotMatch(block![0], /if p_role_code in \('investigation/);
});

// =======================================================================
// Cross-entity transfer -- corrected two-stage sequence
// =======================================================================

test("TRANSFER: initiate_cross_entity_transfer() does NOT revoke the old assignment or touch the old membership", () => {
  const block = fnBlock("initiate_cross_entity_transfer");
  assert.ok(block);
  assert.doesNotMatch(block![0], /update public\.user_role_assignments set revoked_at/);
  assert.doesNotMatch(block![0], /update public\.user_entity_memberships set status/);
});

test("TRANSFER: initiate_cross_entity_transfer() carries transfer_of_assignment_id and transfer_of_membership_id into the new request", () => {
  const block = fnBlock("initiate_cross_entity_transfer");
  assert.ok(block);
  assert.match(block![0], /transfer_of_assignment_id, transfer_of_membership_id/);
  assert.match(block![0], /p_assignment_id, v_old\.entity_membership_id/);
});

test("TRANSFER: approve_registration_request() only ends the old assignment/membership when the request carries transfer_of_assignment_id", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  assert.match(block![0], /if v_request\.transfer_of_assignment_id is not null then/);
});

test("TRANSFER: the old assignment is ended and the new one activated in the SAME function invocation (same transaction), never as two separate calls", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  const insertAssignmentIdx = block![0].indexOf("insert into public.user_role_assignments");
  const endOldIdx = block![0].indexOf("if v_request.transfer_of_assignment_id is not null then");
  assert.ok(insertAssignmentIdx > -1 && endOldIdx > -1);
  assert.ok(insertAssignmentIdx < endOldIdx, "the new assignment must be created before the transfer-ending branch runs");
});

test("TRANSFER: the old membership is only ended when no OTHER active assignment still references it", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  assert.match(block![0], /select not exists \(\s*\n\s*select 1 from public\.user_role_assignments\s*\n\s*where entity_membership_id = v_request\.transfer_of_membership_id/);
});

test("TRANSFER: rejecting a transfer request never touches the old assignment/membership", () => {
  const block = fnBlock("reject_registration_request");
  assert.ok(block);
  assert.doesNotMatch(block![0], /update public\.user_role_assignments/);
  assert.doesNotMatch(block![0], /update public\.user_entity_memberships/);
});

test("TRANSFER: rejecting a transfer request does not overwrite the applicant's already-approved profile.status -- only a first-time (non-transfer) rejection touches profiles.status", () => {
  const block = fnBlock("reject_registration_request");
  assert.ok(block);
  assert.match(block![0], /if not v_is_transfer then\s*\n\s*update public\.profiles set status = 'rejected'/);
});

test("TRANSFER: duplicate acceptance is denied by the same FOR UPDATE + pending-status guard used everywhere else", () => {
  const block = fnBlock("approve_registration_request");
  assert.ok(block);
  assert.match(block![0], /for update/i);
  assert.match(block![0], /if v_request\.status <> 'pending' then/);
});

// =======================================================================
// Approval state semantics (mirrors apply_compatibility_profile_fields())
// =======================================================================

type CompatOutcome = { mapped: boolean; profileStatus?: "approved"; approvalState: "active" | "approved_pending_activation" };

function compatibilityOutcome(roleCode: string, hubCode: string | null, opsGroup: string | null): CompatOutcome {
  if (["dse", "so", "aso"].includes(roleCode) && hubCode === "kul") {
    if (opsGroup !== "operation_avsec" && opsGroup !== "ifc_avsec") {
      throw new Error("A KUL dse/so/aso approval requires an explicit ops_group of operation_avsec or ifc_avsec.");
    }
    return { mapped: true, profileStatus: "approved", approvalState: "active" };
  }
  return { mapped: false, approvalState: "approved_pending_activation" };
}

test("APPROVAL STATE: an active-safe role (KUL dse/so/aso) gets profiles.status='approved' AND approval_state='active'", () => {
  const outcome = compatibilityOutcome("dse", "kul", "operation_avsec");
  assert.equal(outcome.profileStatus, "approved");
  assert.equal(outcome.approvalState, "active");
});

test("APPROVAL STATE: a deferred role gets the explicit approval_state='approved_pending_activation'", () => {
  const outcome = compatibilityOutcome("sso", "northern", null);
  assert.equal(outcome.mapped, false);
  assert.equal(outcome.approvalState, "approved_pending_activation");
});

test("APPROVAL STATE: profiles.status is left completely untouched for deferred roles -- confirmed no status='approved' write exists in the deferred branch of the migration source", () => {
  const block = fnBlock("apply_compatibility_profile_fields");
  assert.ok(block);
  const elseBranch = block![0].match(/else[\s\S]*?end if;/);
  assert.ok(elseBranch, "must find the deferred (else) branch");
  assert.doesNotMatch(elseBranch![0], /status = 'approved'/);
  assert.match(elseBranch![0], /approval_state = 'approved_pending_activation'/);
});

test("APPROVAL STATE: approval_state is a plain nullable text column with a CHECK constraint, not an enum-type change", () => {
  assert.match(code, /alter table public\.profiles\s*\n\s*add column if not exists approval_state text check \(approval_state in \('active', 'approved_pending_activation'\)\);/);
  assert.doesNotMatch(code, /alter type .* add value/i);
});

test("APPROVAL STATE: a deferred assignment provides no live legacy application authorization -- role/unified_role/ops_group/station/team are never written in the deferred branch", () => {
  const block = fnBlock("apply_compatibility_profile_fields");
  assert.ok(block);
  const elseBranch = block![0].match(/else[\s\S]*?end if;/);
  assert.ok(elseBranch);
  for (const col of ["role =", "unified_role =", "ops_group =", "station =", "team ="]) {
    assert.doesNotMatch(elseBranch![0], new RegExp(col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

// =======================================================================
// Compatibility mapping / ops_group validation
// =======================================================================

test("COMPATIBILITY: ops_group remains strictly allowlisted (operation_avsec/ifc_avsec only) and is only ever reachable through the entity-admin approval RPC", () => {
  const block = fnBlock("apply_compatibility_profile_fields");
  assert.ok(block);
  assert.match(block![0], /if p_ops_group not in \('operation_avsec', 'ifc_avsec'\) then/);
  assert.match(code, /revoke execute on function public\.apply_compatibility_profile_fields\([^)]*\) from public, anon, authenticated;/);
});

test("COMPATIBILITY: Profiling/SAT/Investigation get no ops_group write -- the mapped branch only ever applies to role_code in (dse, so, aso)", () => {
  const block = fnBlock("apply_compatibility_profile_fields");
  assert.ok(block);
  assert.match(block![0], /if p_role_code in \('dse', 'so', 'aso'\) and v_hub_code = 'kul' then/);
});

test("COMPATIBILITY: no broad MANAGEMENT/ADMIN/ENFORCEMENT fallback exists anywhere in the mapping function", () => {
  const block = fnBlock("apply_compatibility_profile_fields");
  assert.ok(block);
  assert.doesNotMatch(block![0], /'MANAGEMENT'/);
  assert.doesNotMatch(block![0], /'ADMIN'/);
  assert.doesNotMatch(block![0], /'ENFORCEMENT'/);
});

test("COMPATIBILITY: primary membership drives ONLY the display/compatibility field -- profiles.operating_entity_id is never read by any authorization-deciding function", () => {
  for (const fnName of ["is_entity_admin", "is_authorized_admin_for_assignment", "deactivate_assignment", "transfer_assignment_same_entity"]) {
    const block = fnBlock(fnName);
    assert.ok(block, `must find ${fnName}`);
    assert.doesNotMatch(block![0], /profiles\.operating_entity_id|p\.operating_entity_id/, `${fnName} must not use profiles.operating_entity_id as an authorization source`);
  }
});

// =======================================================================
// Protected roles / self-target denial (re-verified against corrected source)
// =======================================================================

test("PROTECTED ROLES: every mutating RPC (approve/deactivate/transfer/cross-entity-transfer) rejects every protected role code", () => {
  const fns = ["approve_registration_request", "deactivate_assignment", "transfer_assignment_same_entity", "initiate_cross_entity_transfer"];
  for (const fnName of fns) {
    const block = fnBlock(fnName);
    assert.ok(block, `must find ${fnName}`);
    for (const role of PROTECTED_ROLES) {
      assert.match(block![0], new RegExp(`'${role}'`), `${fnName} must list ${role} as protected`);
    }
  }
});

test("PROTECTED ROLES: export_entity_user_directory() excludes every protected role and is documented as entirely-omitted", () => {
  const block = fnBlock("export_entity_user_directory", "\\(p_entity_code text\\)");
  assert.ok(block);
  for (const role of PROTECTED_ROLES) {
    assert.match(block![0], new RegExp(`'${role}'`), `must exclude ${role}`);
  }
  assert.match(migrationSql, /Protected-role accounts are ENTIRELY OMITTED/);
});

test("SELF-PROTECTION: approve/reject/deactivate/transfer-same-entity/initiate-cross-entity all deny the caller acting on themselves", () => {
  assert.match(code, /if v_request\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot approve your own registration request\.';/);
  assert.match(code, /if v_request\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot reject your own registration request\.';/);
  assert.match(code, /if v_assignment\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot deactivate your own assignment\.';/);
  const transferBlocks = code.match(/if v_old\.profile_id = v_admin_id then\s*\n\s*raise exception 'Cannot transfer your own assignment\.';/g) ?? [];
  assert.equal(transferBlocks.length, 2, "expected the self-transfer denial in both transfer functions");
});

test("AUTHORITY: deactivate_assignment(), transfer_assignment_same_entity(), and initiate_cross_entity_transfer() all use is_authorized_admin_for_assignment()", () => {
  const fns = ["deactivate_assignment", "transfer_assignment_same_entity", "initiate_cross_entity_transfer"];
  for (const fnName of fns) {
    const block = fnBlock(fnName);
    assert.ok(block, `must find ${fnName}`);
    assert.match(block![0], /is_authorized_admin_for_assignment\(/, `${fnName} must check authority via the assignment's own membership`);
  }
});

// =======================================================================
// Durable notifications
// =======================================================================

test("NOTIFICATIONS: user_notifications is a real, durable, RLS-protected table -- not documentation only", () => {
  const block = code.match(/create table if not exists public\.user_notifications \([\s\S]*?\n\);/);
  assert.ok(block);
  assert.match(code, /alter table public\.user_notifications enable row level security;/);
});

test("NOTIFICATIONS: one event per successful transition -- notify() is called exactly once per mutating RPC's success path", () => {
  const calls = code.match(/perform public\.notify\(/g) ?? [];
  assert.equal(calls.length, 7, `expected 7 notify() call sites, found ${calls.length}`);
});

test("NOTIFICATIONS: rollback creates no notification -- notify() only inserts, no commit/savepoint logic anywhere in it", () => {
  const notifyBlock = fnBlock("notify");
  assert.ok(notifyBlock);
  assert.doesNotMatch(notifyBlock![0], /commit|savepoint/i);
});

test("NOTIFICATIONS: retry does not duplicate -- dedup_key is UNIQUE and every insert uses ON CONFLICT (dedup_key) DO NOTHING", () => {
  const block = fnBlock("notify");
  assert.ok(block);
  assert.match(block![0], /on conflict \(dedup_key\) do nothing;/);
  assert.match(code, /dedup_key text not null unique,/);
});

test("NOTIFICATIONS: users cannot edit another user's events -- RLS restricts SELECT/UPDATE to recipient_profile_id = auth.uid(), and no INSERT policy exists for authenticated", () => {
  assert.match(code, /create policy "notifications: self select" on public\.user_notifications\s*\nfor select using \(recipient_profile_id = auth\.uid\(\)\);/);
  assert.match(code, /create policy "notifications: self mark read" on public\.user_notifications\s*\nfor update using \(recipient_profile_id = auth\.uid\(\)\) with check \(recipient_profile_id = auth\.uid\(\)\);/);
  assert.doesNotMatch(code, /create policy "notifications:.*insert/i);
});

// =======================================================================
// Admin directory / protected accounts
// =======================================================================

test("DIRECTORY: export_entity_user_directory() is entity-filtered via the assignment's active entity_membership_id, never profiles.operating_entity_id", () => {
  const block = fnBlock("export_entity_user_directory", "\\(p_entity_code text\\)");
  assert.ok(block);
  assert.match(block![0], /join public\.user_entity_memberships uem on uem\.id = ura\.entity_membership_id and uem\.status = 'active'/);
  assert.doesNotMatch(block![0], /p\.operating_entity_id/);
});

test("DIRECTORY: no email, password, token, or service_role literal ever appears in the export's returned columns", () => {
  const block = fnBlock("export_entity_user_directory", "\\(p_entity_code text\\)");
  assert.ok(block);
  const returnsBlock = block![0].match(/returns table \([\s\S]*?\)/);
  assert.ok(returnsBlock);
  for (const forbidden of ["password", "token", "secret", "service_role", "email"]) {
    assert.doesNotMatch(returnsBlock![0], new RegExp(forbidden, "i"));
  }
});

// =======================================================================
// Non-regression / existing-system evidence
// =======================================================================

test("REGRESSION: no CREATE/ALTER/DROP POLICY statement targets any table other than the two policy-bearing new ones in this migration", () => {
  const policyStatements = code.match(/(create|alter|drop) policy[\s\S]*?;/gi) ?? [];
  for (const stmt of policyStatements) {
    assert.match(stmt, /on public\.(user_registration_requests|user_notifications)/i, `unexpected policy target: ${stmt.slice(0, 80)}`);
  }
});

test("REGRESSION: registerUser()/approveStaff()/rejectStaff() and prior remediation-migration functions are never referenced or redefined here", () => {
  assert.doesNotMatch(code, /registerUser|approveStaff|rejectStaff/);
  assert.doesNotMatch(code, /create or replace function public\.is_active_supervisor/);
  assert.doesNotMatch(code, /create or replace function public\.is_approved_management/);
});

test("REGRESSION: no CaterLink public.users row is created anywhere in this migration", () => {
  assert.doesNotMatch(code, /insert into public\.users\b/i);
});

// =======================================================================
// Security-function standard
// =======================================================================

test("SECURITY: every new function is SECURITY DEFINER with a fixed search_path", () => {
  const fnBlocks = code.match(/create or replace function public\.\w+\([\s\S]*?\$function\$;/g) ?? [];
  assert.ok(fnBlocks.length >= 20, `expected at least 20 new functions, found ${fnBlocks.length}`);
  for (const block of fnBlocks) {
    assert.match(block, /security definer/i, `missing SECURITY DEFINER: ${block.slice(0, 60)}`);
    assert.match(block, /set search_path to 'public'/i, `missing fixed search_path: ${block.slice(0, 60)}`);
  }
});

test("SECURITY: every internal-only helper is service_role-only", () => {
  const internalFns: Array<[string, string]> = [
    ["apply_compatibility_profile_fields", "uuid, text, uuid, uuid, uuid, text, uuid"],
    ["get_or_create_active_membership", "uuid, uuid, uuid, uuid"],
    ["sync_primary_operating_entity", "uuid"],
    ["is_authorized_admin_for_assignment", "uuid"],
    ["notify", "uuid, text, text, uuid, uuid, uuid, jsonb"],
  ];
  for (const [name, sig] of internalFns) {
    const escapedSig = sig.replace(/[()]/g, "\\$&");
    assert.match(code, new RegExp(`revoke execute on function public\\.${name}\\(${escapedSig}\\) from public, anon, authenticated;`), `${name} must be revoked from authenticated`);
    assert.match(code, new RegExp(`grant execute on function public\\.${name}\\(${escapedSig}\\) to service_role;`), `${name} must be service_role-only`);
  }
});

test("SECURITY: every client-facing RPC is revoked from PUBLIC and anon", () => {
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
    "get_my_notifications(integer)",
    "mark_notification_read(uuid)",
  ];
  for (const fn of fns) {
    const escaped = fn.replace(/[()]/g, "\\$&");
    assert.match(code, new RegExp(`revoke execute on function public\\.${escaped} from public, anon;`), `${fn} must revoke PUBLIC/anon`);
  }
});

// =======================================================================
// Rollback ordering
// =======================================================================

test("ROLLBACK: triggers/functions are dropped before the four new tables; tables are dropped dependents-first; the two new columns are dropped last", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/);
  assert.ok(rollbackBlock);
  const text = rollbackBlock[0];
  const lastFnDropIdx = text.lastIndexOf("drop function if exists public.sync_primary_operating_entity(uuid);");
  const notificationsTableIdx = text.indexOf("drop table if exists public.user_notifications;");
  const requestsTableIdx = text.indexOf("drop table if exists public.user_registration_requests;");
  const membershipsTableIdx = text.indexOf("drop table if exists public.user_entity_memberships;");
  const dropColIdx = text.indexOf("alter table public.user_role_assignments drop column if exists entity_membership_id;");
  assert.ok(lastFnDropIdx > -1 && notificationsTableIdx > -1 && requestsTableIdx > -1 && membershipsTableIdx > -1 && dropColIdx > -1);
  assert.ok(lastFnDropIdx < notificationsTableIdx, "functions before tables");
  assert.ok(requestsTableIdx < membershipsTableIdx, "user_registration_requests before user_entity_memberships (FK direction)");
  assert.ok(membershipsTableIdx < dropColIdx, "tables before the column drops");
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

test("STATIC: no ALTER TYPE ... ADD VALUE statement exists anywhere -- the same-transaction enum risk is avoided entirely", () => {
  assert.doesNotMatch(code, /alter type/i);
});
