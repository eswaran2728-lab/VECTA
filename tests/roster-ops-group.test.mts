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
