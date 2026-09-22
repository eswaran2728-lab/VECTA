import test from "node:test";
import assert from "node:assert/strict";
import { ROLE_RANK, type UserRole } from "../lib/avsec/reference-data.ts";

/** Central rule matching lib/avsec/auth.ts */
function requiresDailyReport(role: string | null | undefined): boolean {
  return (role ?? "").toUpperCase() === "ASO";
}
type ProfileRole = "ASO" | "SO" | "DSE" | "ADMIN" | "ENFORCEMENT" | "MANAGEMENT";
const DAILY_REPORT_ROLES: ProfileRole[] = (["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"] as ProfileRole[]).filter(
  requiresDailyReport,
);

/**
 * Pure model of the PostgreSQL RLS Policy on report_sec014:
 * create policy "sec014 own insert" on public.report_sec014
 *   for insert with check (
 *     profile_id = auth.uid()
 *     and current_role_name() = any (array['ASO'::user_role, 'ENFORCEMENT'::user_role])
 *     and current_status() = 'approved'::profile_status
 *   );
 */
function canInsertSec014(user: { id: string; role: string; status: string }, targetProfileId: string): boolean {
  if (user.id !== targetProfileId) return false;
  if (user.status !== "approved") return false;
  return ["ASO", "ENFORCEMENT"].includes(user.role);
}

interface SubmitterInfo {
  profile_id: string;
  role: UserRole;
  station: string;
  team: string | null;
  ops_group: string | null;
}

interface AcknowledgerInfo {
  id: string;
  role: UserRole;
  station: string;
  team: string | null;
  ops_group: string | null;
  status: "approved" | "pending" | "rejected";
}

/**
 * Pure model of the public.can_acknowledge_report(text, uuid) SQL function.
 * With the proper fix, ops_group MUST match across submitter and acknowledger.
 */
function canAcknowledgeReport(
  reportType: string,
  submitter: SubmitterInfo,
  acker: AcknowledgerInfo,
  enforceOpsGroup: boolean = true
): boolean {
  if (acker.status !== "approved") return false;
  if (acker.id === submitter.profile_id) return false; // Self-acknowledgement forbidden

  // Rank eligibility:
  // For SEC014: ASO submitter can be acknowledged by either SO or DSE
  // For other reports: strictly rank + 1
  let rankEligible = false;
  if (reportType === "sec014" && submitter.role === "ASO") {
    rankEligible = acker.role === "SO" || acker.role === "DSE";
  } else {
    rankEligible = ROLE_RANK[acker.role] === ROLE_RANK[submitter.role] + 1;
  }

  if (!rankEligible) return false;
  if (acker.station !== submitter.station) return false;
  if ((acker.team ?? "") !== (submitter.team ?? "")) return false;

  if (enforceOpsGroup) {
    // Plain equality, deliberately NOT coalesced -- matches the deployed
    // SQL exactly (supabase/migrations/20260922000004_...): if either
    // side's ops_group is null, this must be false, never a match.
    if (acker.ops_group === null || submitter.ops_group === null) return false;
    if (acker.ops_group !== submitter.ops_group) return false;
  }

  return true;
}

// -------------------------------------------------------------------------
// SEC014 Daily Report Insertion Tests
// -------------------------------------------------------------------------

test("SEC014 Daily Report Role Model: requiresDailyReport is true ONLY for ASO", () => {
  assert.equal(requiresDailyReport("ASO"), true);
  assert.equal(requiresDailyReport("aso"), true);

  assert.equal(requiresDailyReport("SO"), false);
  assert.equal(requiresDailyReport("DSE"), false);
  assert.equal(requiresDailyReport("ENFORCEMENT"), false);
  assert.equal(requiresDailyReport("MANAGEMENT"), false);
  assert.equal(requiresDailyReport("ADMIN"), false);
  assert.equal(requiresDailyReport("SUPER_ADMIN"), false);
});

test("SEC014 Daily Report Role Model: DAILY_REPORT_ROLES contains only ASO", () => {
  assert.deepEqual(DAILY_REPORT_ROLES, ["ASO"]);
});

test("SEC014 Insert RLS: ASO SEC014 INSERT -> ALLOWED", () => {
  const asoUser = { id: "usr-aso-01", role: "ASO", status: "approved" };
  assert.equal(canInsertSec014(asoUser, "usr-aso-01"), true);
});

test("SEC014 Insert RLS: SO SEC014 INSERT -> DENIED", () => {
  const soUser = { id: "usr-so-01", role: "SO", status: "approved" };
  assert.equal(canInsertSec014(soUser, "usr-so-01"), false);
});

test("SEC014 Insert RLS: DSE SEC014 INSERT -> DENIED", () => {
  const dseUser = { id: "usr-dse-01", role: "DSE", status: "approved" };
  assert.equal(canInsertSec014(dseUser, "usr-dse-01"), false);
});

test("SEC014 Insert RLS: Insertion for another profile_id -> DENIED", () => {
  const asoUser = { id: "usr-aso-01", role: "ASO", status: "approved" };
  assert.equal(canInsertSec014(asoUser, "usr-aso-02"), false);
});

// -------------------------------------------------------------------------
// SEC014 Supervisory Acknowledgement Tests
// -------------------------------------------------------------------------

const asoOpsAlphaSubmitter: SubmitterInfo = {
  profile_id: "usr-aso-ops-alpha",
  role: "ASO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
};

const soOpsAlphaAcker: AcknowledgerInfo = {
  id: "usr-so-ops-alpha",
  role: "SO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
  status: "approved",
};

const dseOpsAlphaAcker: AcknowledgerInfo = {
  id: "usr-dse-ops-alpha",
  role: "DSE",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
  status: "approved",
};

test("SEC014 Acknowledgement: ASO acknowledges own SEC014 -> DENIED SERVER-SIDE", () => {
  const asoSelfAcker: AcknowledgerInfo = {
    id: "usr-aso-ops-alpha",
    role: "ASO",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    status: "approved",
  };
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, asoSelfAcker), false);
});

test("SEC014 Acknowledgement: SO acknowledges eligible ASO SEC014 -> ALLOWED", () => {
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soOpsAlphaAcker), true);
});

test("SEC014 Acknowledgement: DSE acknowledges eligible ASO SEC014 -> ALLOWED", () => {
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, dseOpsAlphaAcker), true);
});

test("SEC014 Acknowledgement: Unauthorized team acknowledgement (Bravo -> Alpha) -> DENIED", () => {
  const soOpsBravoAcker: AcknowledgerInfo = {
    id: "usr-so-ops-bravo",
    role: "SO",
    station: "KUL - MAA",
    team: "BRAVO",
    ops_group: "operation_avsec",
    status: "approved",
  };
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soOpsBravoAcker), false);
});

test("SEC014 Acknowledgement: Unauthorized station acknowledgement (PEN -> KUL) -> DENIED", () => {
  const soPenAlphaAcker: AcknowledgerInfo = {
    id: "usr-so-pen-alpha",
    role: "SO",
    station: "PEN",
    team: "ALPHA",
    ops_group: "operation_avsec",
    status: "approved",
  };
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soPenAlphaAcker), false);
});

test("SEC014 Acknowledgement: Cross-branch acknowledgement (IFC SO -> Ops ASO) -> MUST BE DENIED", () => {
  const soIfcAlphaAcker: AcknowledgerInfo = {
    id: "usr-so-ifc-alpha",
    role: "SO",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "ifc_avsec",
    status: "approved",
  };
  // With enforceOpsGroup = true, cross branch is blocked
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soIfcAlphaAcker, true), false);
});

test("SEC014 Acknowledgement: Cross-branch acknowledgement (Ops DSE -> IFC ASO) -> MUST BE DENIED", () => {
  const asoIfcAlphaSubmitter: SubmitterInfo = {
    profile_id: "usr-aso-ifc-alpha",
    role: "ASO",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "ifc_avsec",
  };
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, dseOpsAlphaAcker, true), false);
});

// -------------------------------------------------------------------------
// Confirmed authorization vulnerability, found + fixed 2026-09-22
// (supabase/migrations/20260922000004_report_acknowledgement_ops_group_isolation.sql).
// Live-proven against real production data before the fix: SO Alpha (IFC)
// evaluated TRUE against ASO Alpha (Ops)'s real submitted SEC014 report,
// because can_acknowledge_report() checked role-rank + station + team but
// never ops_group, and team NAMES collide across branches ("Team ALPHA"
// exists in both Operation and IFC AVSEC at the same station).
// -------------------------------------------------------------------------

const asoIfcAlphaSubmitter: SubmitterInfo = {
  profile_id: "usr-aso-ifc-alpha",
  role: "ASO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "ifc_avsec",
};

const soIfcAlphaAcker: AcknowledgerInfo = {
  id: "usr-so-ifc-alpha",
  role: "SO",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "ifc_avsec",
  status: "approved",
};

const dseIfcAlphaAcker: AcknowledgerInfo = {
  id: "usr-dse-ifc-alpha",
  role: "DSE",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "ifc_avsec",
  status: "approved",
};

test("REGRESSION: Operation SO cannot acknowledge IFC ASO reports", () => {
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, soOpsAlphaAcker), false);
});

test("REGRESSION: IFC SO cannot acknowledge Operation ASO reports (the exact live-proven case)", () => {
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soIfcAlphaAcker), false);
});

test("REGRESSION: Operation DSE cannot acknowledge IFC ASO reports", () => {
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, dseOpsAlphaAcker), false);
});

test("REGRESSION: IFC DSE cannot acknowledge Operation ASO reports", () => {
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, dseIfcAlphaAcker), false);
});

test("REGRESSION: same-branch acknowledgement still succeeds (IFC SO -> IFC ASO)", () => {
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, soIfcAlphaAcker), true);
});

test("REGRESSION: same-branch acknowledgement still succeeds (IFC DSE -> IFC ASO)", () => {
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, dseIfcAlphaAcker), true);
});

test("REGRESSION: wrong station remains denied even when ops_group and team match", () => {
  const soIfcAlphaPen: AcknowledgerInfo = { ...soIfcAlphaAcker, id: "usr-so-ifc-alpha-pen", station: "PEN" };
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, soIfcAlphaPen), false);
});

test("REGRESSION: wrong team remains denied even when ops_group and station match", () => {
  const soIfcBravo: AcknowledgerInfo = { ...soIfcAlphaAcker, id: "usr-so-ifc-bravo", team: "BRAVO" };
  assert.equal(canAcknowledgeReport("sec014", asoIfcAlphaSubmitter, soIfcBravo), false);
});

test("REGRESSION: null ops_group on the acknowledger cannot create a bypass", () => {
  const soNullOpsGroup: AcknowledgerInfo = { ...soOpsAlphaAcker, id: "usr-so-null-ops", ops_group: null };
  // Plain equality (not coalesced): a null acknowledger ops_group must
  // never match a real submitter ops_group, in either direction.
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, soNullOpsGroup), false);
});

test("REGRESSION: null ops_group on the submitter cannot create a bypass", () => {
  const asoNullOpsGroupSubmitter: SubmitterInfo = { ...asoOpsAlphaSubmitter, profile_id: "usr-aso-null-ops", ops_group: null };
  assert.equal(canAcknowledgeReport("sec014", asoNullOpsGroupSubmitter, soOpsAlphaAcker), false);
});

test("REGRESSION: both sides null ops_group cannot create a bypass (deliberately NOT coalesced to '' === '')", () => {
  const asoNullSubmitter: SubmitterInfo = { ...asoOpsAlphaSubmitter, profile_id: "usr-aso-null-both", ops_group: null };
  const soNullAcker: AcknowledgerInfo = { ...soOpsAlphaAcker, id: "usr-so-null-both", ops_group: null };
  assert.equal(canAcknowledgeReport("sec014", asoNullSubmitter, soNullAcker), false);
});

test("REGRESSION: MANAGEMENT/ADMIN (org-wide, station=null) have no acknowledgement authority through this function - unchanged by the fix", () => {
  // Org-wide roles were never eligible here even before this fix: their
  // station is null in profiles, and acker.station !== submitter.station
  // already rejects a null-vs-real-station comparison. This test
  // documents that the ops_group fix does not change that pre-existing
  // (and correct) behavior - org-wide oversight is granted elsewhere
  // (report SELECT policies via is_monitor_or_above()), not through
  // can_acknowledge_report().
  const managementOrgWideAcker: AcknowledgerInfo = {
    id: "usr-management-01",
    role: "MANAGEMENT" as UserRole,
    station: "" as unknown as string,
    team: null,
    ops_group: null,
    status: "approved",
  };
  assert.equal(canAcknowledgeReport("sec014", asoOpsAlphaSubmitter, managementOrgWideAcker), false);
});
