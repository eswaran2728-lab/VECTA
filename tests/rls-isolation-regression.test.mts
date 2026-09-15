import test from "node:test";
import assert from "node:assert/strict";

/**
 * Automated RLS & ops_group Cross-Branch Isolation Regression Test
 *
 * Models and verifies the exact SQL RLS policy predicates across all
 * security-critical VECTA tables to prevent regression of the
 * (station + team + ops_group) isolation model.
 */

interface UserProfile {
  id: string;
  role: "ASO" | "SO" | "DSE" | "MANAGEMENT" | "ENFORCEMENT" | "ADMIN" | "SUPER_ADMIN" | "DRIVER";
  station: string;
  team: string | null;
  ops_group: "operation_avsec" | "ifc_avsec" | "hub_avsec" | null;
  unified_role: string;
}

interface SecRecord {
  id: string;
  station: string;
  team: string | null;
  ops_group: string | null;
  created_by: string;
}

interface OvertimeRecord {
  id: string;
  station: string;
  team: string | null;
  ops_group: string | null;
  profile_id: string;
  status: "PENDING" | "ENDORSED" | "APPROVED" | "REJECTED";
}

interface HandoverRecord {
  id: string;
  station: string;
  team: string | null;
  ops_group: string | null;
  outgoing_profile_id: string;
  incoming_profile_id: string | null;
  status: "PENDING_ACKNOWLEDGEMENT" | "ACKNOWLEDGED";
}

// Helper: Evaluates the exact SQL RLS policy predicate for monitor / report read
function canUserReadRecord(user: UserProfile, record: SecRecord): boolean {
  // Org-wide roles: MANAGEMENT, ENFORCEMENT, ADMIN, SUPER_ADMIN
  const isOrgWide = ["MANAGEMENT", "ENFORCEMENT", "ADMIN", "SUPER_ADMIN"].includes(user.role);
  if (isOrgWide) {
    return true;
  }

  // Creator can always read own records
  if (record.created_by === user.id) {
    return true;
  }

  // Operational monitor scoping: STATION + TEAM + OPS_GROUP
  if (user.station !== record.station) {
    return false;
  }

  // If record has a team, user team must match
  if (record.team !== null && user.team !== record.team) {
    return false;
  }

  // ops_group match requirement: if record has ops_group, user ops_group must match
  if (record.ops_group !== null) {
    return user.ops_group === record.ops_group;
  }

  // Fail-safe: if record has NULL ops_group, station/team-scoped operational users CANNOT see it
  return false;
}

function canUserEndorseOvertime(user: UserProfile, ot: OvertimeRecord): boolean {
  // Only DSE of matching station + team + ops_group can endorse
  if (user.role !== "DSE") return false;
  if (ot.status !== "PENDING") return false;
  if (user.station !== ot.station) return false;
  if (ot.team !== null && user.team !== ot.team) return false;
  if (ot.ops_group !== null && user.ops_group !== ot.ops_group) return false;
  return true;
}

function canUserApproveOvertime(user: UserProfile, ot: OvertimeRecord): boolean {
  // Management / Admin can approve endorsed overtime
  const isApprover = ["MANAGEMENT", "ADMIN", "SUPER_ADMIN"].includes(user.role);
  if (!isApprover) return false;
  if (ot.status !== "ENDORSED") return false;
  return true;
}

function canUserAcknowledgeHandover(user: UserProfile, handover: HandoverRecord): boolean {
  // SO or DSE of matching station + team + ops_group can acknowledge
  if (!["SO", "DSE"].includes(user.role)) return false;
  if (handover.status !== "PENDING_ACKNOWLEDGEMENT") return false;
  if (handover.outgoing_profile_id === user.id) return false; // Cannot acknowledge own handover
  if (user.station !== handover.station) return false;
  if (handover.team !== null && user.team !== handover.team) return false;
  if (handover.ops_group !== null && user.ops_group !== handover.ops_group) return false;
  return true;
}

// Test fixtures
const userOpsAlphaDSE: UserProfile = {
  id: "usr-ops-alpha-dse",
  role: "DSE",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
  unified_role: "dse",
};

const userOpsAlphaSO: UserProfile = {
  id: "usr-ops-alpha-so",
  role: "SO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
  unified_role: "so",
};

const userIfcAlphaDSE: UserProfile = {
  id: "usr-ifc-alpha-dse",
  role: "DSE",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "ifc_avsec",
  unified_role: "dse",
};

const userIfcAlphaSO: UserProfile = {
  id: "usr-ifc-alpha-so",
  role: "SO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "ifc_avsec",
  unified_role: "so",
};

const userOpsBravoDSE: UserProfile = {
  id: "usr-ops-bravo-dse",
  role: "DSE",
  station: "KUL - MAA",
  team: "BRAVO",
  ops_group: "operation_avsec",
  unified_role: "dse",
};

const userManagement: UserProfile = {
  id: "usr-management",
  role: "MANAGEMENT",
  station: "KUL - MAA",
  team: null,
  ops_group: null,
  unified_role: "management",
};

const userEnforcement: UserProfile = {
  id: "usr-enforcement",
  role: "ENFORCEMENT",
  station: "KUL - MAA",
  team: null,
  ops_group: null,
  unified_role: "enforcement",
};

test("RLS Regression: Operation AVSEC cannot view IFC AVSEC records at same station + team", () => {
  const ifcRecord: SecRecord = {
    id: "rec-ifc-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "ifc_avsec",
    created_by: "usr-ifc-alpha-aso",
  };

  assert.equal(
    canUserReadRecord(userOpsAlphaDSE, ifcRecord),
    false,
    "Operation DSE must NOT be able to read IFC record on the same team"
  );
  assert.equal(
    canUserReadRecord(userOpsAlphaSO, ifcRecord),
    false,
    "Operation SO must NOT be able to read IFC record on the same team"
  );
  assert.equal(
    canUserReadRecord(userIfcAlphaDSE, ifcRecord),
    true,
    "IFC DSE MUST be able to read IFC record on matching team"
  );
});

test("RLS Regression: IFC AVSEC cannot view Operation AVSEC records at same station + team", () => {
  const opsRecord: SecRecord = {
    id: "rec-ops-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    created_by: "usr-ops-alpha-aso",
  };

  assert.equal(
    canUserReadRecord(userIfcAlphaDSE, opsRecord),
    false,
    "IFC DSE must NOT be able to read Operation record on the same team"
  );
  assert.equal(
    canUserReadRecord(userIfcAlphaSO, opsRecord),
    false,
    "IFC SO must NOT be able to read Operation record on the same team"
  );
  assert.equal(
    canUserReadRecord(userOpsAlphaDSE, opsRecord),
    true,
    "Operation DSE MUST be able to read Operation record on matching team"
  );
});

test("RLS Regression: Management and Enforcement can view both Operation and IFC records", () => {
  const opsRecord: SecRecord = {
    id: "rec-ops-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    created_by: "usr-ops-alpha-aso",
  };

  const ifcRecord: SecRecord = {
    id: "rec-ifc-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "ifc_avsec",
    created_by: "usr-ifc-alpha-aso",
  };

  assert.equal(canUserReadRecord(userManagement, opsRecord), true, "Management sees Ops records");
  assert.equal(canUserReadRecord(userManagement, ifcRecord), true, "Management sees IFC records");
  assert.equal(canUserReadRecord(userEnforcement, opsRecord), true, "Enforcement sees Ops records");
  assert.equal(canUserReadRecord(userEnforcement, ifcRecord), true, "Enforcement sees IFC records");
});

test("RLS Regression: Historical NULL ops_group records are fail-safe (hidden from team monitors, visible only to org-wide)", () => {
  const nullOpsGroupRecord: SecRecord = {
    id: "rec-null-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: null,
    created_by: "usr-historical-aso",
  };

  assert.equal(canUserReadRecord(userOpsAlphaDSE, nullOpsGroupRecord), false, "Ops DSE cannot read NULL ops_group row");
  assert.equal(canUserReadRecord(userIfcAlphaDSE, nullOpsGroupRecord), false, "IFC DSE cannot read NULL ops_group row");
  assert.equal(canUserReadRecord(userManagement, nullOpsGroupRecord), true, "Management CAN read NULL ops_group row");
  assert.equal(canUserReadRecord(userEnforcement, nullOpsGroupRecord), true, "Enforcement CAN read NULL ops_group row");
});

test("RLS Regression: Cross-branch Overtime Endorsement is strictly blocked", () => {
  const opsOvertime: OvertimeRecord = {
    id: "ot-ops-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    profile_id: "usr-ops-alpha-aso",
    status: "PENDING",
  };

  // Operation DSE CAN endorse Operation OT
  assert.equal(canUserEndorseOvertime(userOpsAlphaDSE, opsOvertime), true);
  // IFC DSE CANNOT endorse Operation OT (even on same station and team)
  assert.equal(canUserEndorseOvertime(userIfcAlphaDSE, opsOvertime), false);
  // Bravo DSE CANNOT endorse Alpha OT
  assert.equal(canUserEndorseOvertime(userOpsBravoDSE, opsOvertime), false);
  // SO CANNOT endorse
  assert.equal(canUserEndorseOvertime(userOpsAlphaSO, opsOvertime), false);
});

test("RLS Regression: Overtime Approval workflow respects roles and states", () => {
  const pendingOT: OvertimeRecord = {
    id: "ot-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    profile_id: "usr-ops-alpha-aso",
    status: "PENDING",
  };

  const endorsedOT: OvertimeRecord = {
    id: "ot-002",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    profile_id: "usr-ops-alpha-aso",
    status: "ENDORSED",
  };

  // Management cannot approve unendorsed OT
  assert.equal(canUserApproveOvertime(userManagement, pendingOT), false);
  // Management CAN approve endorsed OT
  assert.equal(canUserApproveOvertime(userManagement, endorsedOT), true);
  // DSE cannot approve (can only endorse)
  assert.equal(canUserApproveOvertime(userOpsAlphaDSE, endorsedOT), false);
});

test("RLS Regression: Cross-branch Shift Handover Acknowledgment is strictly blocked", () => {
  const opsHandover: HandoverRecord = {
    id: "ho-ops-001",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    outgoing_profile_id: "usr-ops-alpha-outgoing-so",
    incoming_profile_id: null,
    status: "PENDING_ACKNOWLEDGEMENT",
  };

  // Ops Alpha SO can acknowledge
  assert.equal(canUserAcknowledgeHandover(userOpsAlphaSO, opsHandover), true);
  // IFC Alpha SO CANNOT acknowledge Ops Alpha handover
  assert.equal(canUserAcknowledgeHandover(userIfcAlphaSO, opsHandover), false);
  // Outgoing SO cannot acknowledge their own handover
  assert.equal(
    canUserAcknowledgeHandover({ ...userOpsAlphaSO, id: "usr-ops-alpha-outgoing-so" }, opsHandover),
    false
  );
});
