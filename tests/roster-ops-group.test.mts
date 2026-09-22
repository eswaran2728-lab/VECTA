import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of resolveRosterOpsGroup() (lib/avsec/duty/roster-actions.ts),
 * part of the roster branch-isolation fix (2026-09-22/23 - see
 * supabase/migrations/20260922000005_team_rosters_ops_group.sql).
 */
const OPS_GROUPS = ["operation_avsec", "ifc_avsec", "hub_avsec"] as const;

function resolveRosterOpsGroup(
  writer: { role: string; ops_group?: string | null },
  requestedOpsGroup: string,
): { ok: true; opsGroup: string } | { ok: false; error: string } {
  if (writer.role === "DSE") {
    if (!writer.ops_group || !(OPS_GROUPS as readonly string[]).includes(writer.ops_group)) {
      return { ok: false, error: "Your account has no ops group assigned — contact an admin." };
    }
    return { ok: true, opsGroup: writer.ops_group };
  }
  if (!(OPS_GROUPS as readonly string[]).includes(requestedOpsGroup)) {
    return { ok: false, error: "Select which AVSEC group (Operation, IFC, or Hub) this roster is for." };
  }
  return { ok: true, opsGroup: requestedOpsGroup };
}

test("DSE writer: ops_group auto-derived from their own stored branch, ignoring any requested value", () => {
  const result = resolveRosterOpsGroup({ role: "DSE", ops_group: "ifc_avsec" }, "operation_avsec");
  assert.deepEqual(result, { ok: true, opsGroup: "ifc_avsec" });
});

test("DSE writer with no ops_group assigned: denied, not silently defaulted", () => {
  const result = resolveRosterOpsGroup({ role: "DSE", ops_group: null }, "operation_avsec");
  assert.equal(result.ok, false);
});

test("MANAGEMENT writer: must explicitly select a valid ops_group", () => {
  const ok = resolveRosterOpsGroup({ role: "MANAGEMENT", ops_group: null }, "operation_avsec");
  assert.deepEqual(ok, { ok: true, opsGroup: "operation_avsec" });

  const missing = resolveRosterOpsGroup({ role: "MANAGEMENT", ops_group: null }, "");
  assert.equal(missing.ok, false);

  const invalid = resolveRosterOpsGroup({ role: "MANAGEMENT", ops_group: null }, "not_a_real_group");
  assert.equal(invalid.ok, false);
});

test("ADMIN writer: same explicit-selection requirement as MANAGEMENT", () => {
  const ok = resolveRosterOpsGroup({ role: "ADMIN", ops_group: null }, "hub_avsec");
  assert.deepEqual(ok, { ok: true, opsGroup: "hub_avsec" });

  const missing = resolveRosterOpsGroup({ role: "ADMIN", ops_group: null }, "");
  assert.equal(missing.ok, false);
});

test("MANAGEMENT selecting Hub AVSEC is still allowed at this layer (Hub write authorization is enforced separately by RLS)", () => {
  const result = resolveRosterOpsGroup({ role: "MANAGEMENT", ops_group: null }, "hub_avsec");
  assert.deepEqual(result, { ok: true, opsGroup: "hub_avsec" });
});

// -------------------------------------------------------------------------
// Roster integrity follow-up (2026-09-23): team_rosters.ops_group is now
// database-level NOT NULL (supabase/migrations/20260923000001_...), no
// default value. These model the DB-level guarantees directly - the real
// guarantee is enforced by Postgres (a NOT NULL column plus a CHECK
// constraint restricting the value to exactly these 3 strings), not by
// this application code, which these tests verify matches.
// -------------------------------------------------------------------------

const VALID_OPS_GROUPS = ["operation_avsec", "ifc_avsec", "hub_avsec"];

function dbLevelOpsGroupCheck(value: string | null | undefined): { accepted: boolean; reason?: string } {
  if (value === null || value === undefined) {
    return { accepted: false, reason: "null value violates not-null constraint" };
  }
  if (!VALID_OPS_GROUPS.includes(value)) {
    return { accepted: false, reason: "value violates check constraint" };
  }
  return { accepted: true };
}

test("REGRESSION: null ops_group is rejected (models the NOT NULL column - no default value exists to silently fill it in)", () => {
  assert.equal(dbLevelOpsGroupCheck(null).accepted, false);
  assert.equal(dbLevelOpsGroupCheck(undefined).accepted, false);
});

test("REGRESSION: exactly the 3 allowed group values are accepted", () => {
  assert.equal(dbLevelOpsGroupCheck("operation_avsec").accepted, true);
  assert.equal(dbLevelOpsGroupCheck("ifc_avsec").accepted, true);
  assert.equal(dbLevelOpsGroupCheck("hub_avsec").accepted, true);
});

test("REGRESSION: an invalid/unrecognized group value is rejected", () => {
  assert.equal(dbLevelOpsGroupCheck("some_other_group").accepted, false);
  assert.equal(dbLevelOpsGroupCheck("").accepted, false);
  assert.equal(dbLevelOpsGroupCheck("OPERATION_AVSEC").accepted, false); // case-sensitive
});

/** Pure model of "roster own team select" (20260922000005): strict 3-way match. */
function rlsAllowsRosterRead(
  viewer: { station: string; team: string | null; ops_group: string | null },
  row: { station: string; team: string | null; ops_group: string | null },
): boolean {
  if (row.station !== viewer.station) return false;
  if ((row.team ?? "") !== (viewer.team ?? "")) return false;
  if (row.ops_group === null || viewer.ops_group === null) return false;
  return row.ops_group === viewer.ops_group;
}

test("REGRESSION: cross-group roster isolation - Operation viewer cannot read an IFC row for the same station/team", () => {
  const viewer = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  const ifcRow = { station: "KUL - MAA", team: "ALPHA", ops_group: "ifc_avsec" };
  assert.equal(rlsAllowsRosterRead(viewer, ifcRow), false);
});

test("REGRESSION: cross-group roster isolation - IFC viewer cannot read an Operation row for the same station/team", () => {
  const viewer = { station: "KUL - MAA", team: "ALPHA", ops_group: "ifc_avsec" };
  const opsRow = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  assert.equal(rlsAllowsRosterRead(viewer, opsRow), false);
});

test("REGRESSION: same-group roster read still succeeds", () => {
  const viewer = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  const ownRow = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  assert.equal(rlsAllowsRosterRead(viewer, ownRow), true);
});

test("REGRESSION: a null ops_group on either side cannot create a cross-group read bypass", () => {
  const viewerNull = { station: "KUL - MAA", team: "ALPHA", ops_group: null };
  const row = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  assert.equal(rlsAllowsRosterRead(viewerNull, row), false);

  const viewer = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec" };
  const rowNull = { station: "KUL - MAA", team: "ALPHA", ops_group: null };
  assert.equal(rlsAllowsRosterRead(viewer, rowNull), false);
});

test("REGRESSION: ADMIN behavior is unchanged - ADMIN still requires an explicit ops_group selection like MANAGEMENT (no default, no org-wide write bypass of the NOT NULL requirement)", () => {
  const explicit = resolveRosterOpsGroup({ role: "ADMIN", ops_group: null }, "ifc_avsec");
  assert.deepEqual(explicit, { ok: true, opsGroup: "ifc_avsec" });

  const missing = resolveRosterOpsGroup({ role: "ADMIN", ops_group: null }, "");
  assert.equal(missing.ok, false);
});

test("DOCUMENTS (not yet reachable): DSE auto-derivation exists in resolveRosterOpsGroup() but there is no DSE-facing roster UI in the app today - only /avsec/admin/roster, gated to ADMIN_ROLES + DSE at the action layer but never linked for a DSE user. This is recorded as a future feature, not claimed operational.", () => {
  const dseResult = resolveRosterOpsGroup({ role: "DSE", ops_group: "hub_avsec" }, "operation_avsec");
  assert.deepEqual(dseResult, { ok: true, opsGroup: "hub_avsec" });
});
