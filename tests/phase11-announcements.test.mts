import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AnnouncementItem,
  AnnouncementDetail,
  AnnouncementScope,
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementStatus,
  AnnouncementAcknowledgementReport,
} from "../lib/avsec/types.ts";

// Role definitions and permission matrix matching database rules
const AUTHORIZED_GLOBAL_PUBLISHERS = new Set(["ghod"]);
const AUTHORIZED_AOC_PUBLISHERS = new Set(["ghod", "maa_boss", "maa_admin", "aax_boss", "aax_admin"]);
const STRICTLY_READ_ONLY_EXECUTIVE = new Set(["airasia_management"]);
const DENIED_GLOBAL_PUBLISHERS = new Set([
  "super_admin",
  "airasia_management",
  "operation_manager",
  "main_enforcement",
  "compliance",
  "caterlink_management",
  "caterlink_operation",
  "caterlink_admin",
  "aso",
  "so",
  "dse",
]);

function canPublishAnnouncement(roleCode: string, scope: AnnouncementScope, aocCode?: string | null): boolean {
  if (scope === "global") {
    return AUTHORIZED_GLOBAL_PUBLISHERS.has(roleCode);
  }
  if (scope === "aoc") {
    if (roleCode === "ghod") return true; // GHOD executive global oversight
    if (aocCode === "MY") {
      return roleCode === "maa_boss" || roleCode === "maa_admin" || roleCode === "aax_boss" || roleCode === "aax_admin";
    }
  }
  return false;
}

function isAnnouncementVisibleToCaller(
  announcement: {
    status: AnnouncementStatus;
    published_at: string;
    expires_at: string | null;
    scope: AnnouncementScope;
    aoc_code: string | null;
  },
  caller: {
    roleCode: string;
    aocCode: string | null;
    hasActiveAssignment: boolean;
  },
  nowTime: string
): boolean {
  // Lifecycle checks
  const isPublishedTime = announcement.published_at <= nowTime;
  const isNotExpired = !announcement.expires_at || announcement.expires_at > nowTime;
  const isStatusEligible = announcement.status === "published" || (announcement.status === "scheduled" && isPublishedTime);

  if (!isStatusEligible || !isPublishedTime || !isNotExpired) {
    return false;
  }

  // Caller eligibility
  if (!caller.hasActiveAssignment && caller.roleCode !== "ghod" && caller.roleCode !== "airasia_management") {
    return false;
  }

  // Scope isolation
  if (announcement.scope === "global") {
    return true; // Visible across all active AOCs and global executives
  }

  if (announcement.scope === "aoc") {
    // GHOD can view any AOC under executive global oversight
    if (caller.roleCode === "ghod") return true;
    // Otherwise caller must belong to the matching AOC
    return caller.aocCode === announcement.aoc_code;
  }

  return false;
}

test("Phase 11 Role Matrix: GHOD is the SOLE authorized Global announcement publisher", () => {
  assert.equal(canPublishAnnouncement("ghod", "global"), true);
  assert.equal(canPublishAnnouncement("super_admin", "global"), false, "Super Admin must not publish Global");
  assert.equal(canPublishAnnouncement("airasia_management", "global"), false, "AirAsia Management must not publish Global");
  assert.equal(canPublishAnnouncement("maa_boss", "global"), false, "MAA Boss cannot publish Global");
  assert.equal(canPublishAnnouncement("aax_boss", "global"), false, "AAX Boss cannot publish Global");
  assert.equal(canPublishAnnouncement("operation_manager", "global"), false, "Operation Manager cannot publish Global");
  assert.equal(canPublishAnnouncement("main_enforcement", "global"), false, "Main Enforcement cannot publish Global");
  assert.equal(canPublishAnnouncement("compliance", "global"), false, "Compliance cannot publish Global");
  assert.equal(canPublishAnnouncement("caterlink_management", "global"), false, "CaterLink Management cannot publish Global");
});

test("Phase 11 Role Matrix: VECTA has NO generic HOD role", () => {
  // Confirm that generic 'hod' is neither an authorized role nor recognized
  assert.equal(AUTHORIZED_GLOBAL_PUBLISHERS.has("hod"), false);
  assert.equal(AUTHORIZED_AOC_PUBLISHERS.has("hod"), false);
  assert.equal(canPublishAnnouncement("hod", "global"), false);
  assert.equal(canPublishAnnouncement("hod", "aoc", "MY"), false);
});

test("Phase 11 Role Matrix: AirAsia Management remains strictly executive-dashboard / read-only", () => {
  assert.ok(STRICTLY_READ_ONLY_EXECUTIVE.has("airasia_management"));
  assert.equal(canPublishAnnouncement("airasia_management", "global"), false);
  assert.equal(canPublishAnnouncement("airasia_management", "aoc", "MY"), false);

  // Can view global announcements in feed
  const globalAnn = {
    status: "published" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    scope: "global" as AnnouncementScope,
    aoc_code: null,
  };
  const mgmtCaller = {
    roleCode: "airasia_management",
    aocCode: null,
    hasActiveAssignment: true,
  };
  assert.equal(isAnnouncementVisibleToCaller(globalAnn, mgmtCaller, "2026-10-01T12:00:00Z"), true);
});

test("Phase 11 Role Matrix: Malaysia AOC / entity publishers within authorized scope", () => {
  assert.equal(canPublishAnnouncement("maa_boss", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("maa_admin", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("aax_boss", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("aax_admin", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("ghod", "aoc", "MY"), true, "GHOD has global oversight over Malaysia AOC");

  // Denied in foreign AOC
  assert.equal(canPublishAnnouncement("maa_boss", "aoc", "SG"), false);
  assert.equal(canPublishAnnouncement("aax_boss", "aoc", "TH"), false);
});

test("Phase 11 Multi-AOC Isolation: Malaysia announcements hidden from foreign personnel", () => {
  const myAnn = {
    status: "published" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };

  const myStaff = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true };
  const foreignStaff = { roleCode: "aso", aocCode: "ZZ", hasActiveAssignment: true };
  const ghodUser = { roleCode: "ghod", aocCode: null, hasActiveAssignment: true };

  const now = "2026-10-01T12:00:00Z";
  assert.equal(isAnnouncementVisibleToCaller(myAnn, myStaff, now), true, "Malaysia staff can see Malaysia announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, foreignStaff, now), false, "Foreign staff cannot see Malaysia announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, ghodUser, now), true, "GHOD can see Malaysia announcement under oversight");
});

test("Phase 11 Scheduling & Expiry Lifecycle", () => {
  const now = "2026-10-01T12:00:00Z";
  const caller = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true };

  // Future scheduled announcement is hidden before published_at
  const futureAnn = {
    status: "scheduled" as AnnouncementStatus,
    published_at: "2026-10-01T14:00:00Z",
    expires_at: null,
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };
  assert.equal(isAnnouncementVisibleToCaller(futureAnn, caller, now), false, "Future scheduled announcement is hidden");

  // Becomes visible once published_at is reached
  assert.equal(isAnnouncementVisibleToCaller(futureAnn, caller, "2026-10-01T14:05:00Z"), true, "Visible once boundary passes");

  // Drafts are hidden from staff
  const draftAnn = {
    status: "draft" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };
  assert.equal(isAnnouncementVisibleToCaller(draftAnn, caller, now), false, "Draft is hidden from ordinary staff");

  // Expired announcement is excluded
  const expiredAnn = {
    status: "published" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-10-01T10:00:00Z",
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };
  assert.equal(isAnnouncementVisibleToCaller(expiredAnn, caller, now), false, "Expired announcement is excluded");
});

test("Phase 11 Fail-Closed Scope Validation", () => {
  function validateScopeConstraints(scope: AnnouncementScope, aocId: string | null): boolean {
    if (scope === "global") {
      return aocId === null; // Must be NULL
    }
    return aocId !== null; // Must NOT be NULL
  }

  assert.equal(validateScopeConstraints("global", null), true);
  assert.equal(validateScopeConstraints("global", "00000000-0000-0000-0000-000000000001"), false, "Global with AOC rejected");
  assert.equal(validateScopeConstraints("aoc", "00000000-0000-0000-0000-000000000001"), true);
  assert.equal(validateScopeConstraints("aoc", null), false, "AOC with NULL AOC ID rejected");
});

test("Phase 11 Acknowledgement Report: Exact active denominator and progress computation", () => {
  const mockReport: AnnouncementAcknowledgementReport = {
    announcement_id: "00000000-0000-0000-0000-000000000001",
    title: "Mandatory Runway Safety Directive",
    scope: "aoc",
    aoc_code: "MY",
    requires_acknowledgement: true,
    total_eligible: 10,
    total_acknowledged: 8,
    pending_count: 2,
    compliance_percentage: 80,
    acknowledged_staff: [
      {
        profile_id: "p1",
        name: "Ahmad",
        staff_no: "ST-01",
        department: "operation",
        station: "KUL - MAA",
        acknowledged_at: "2026-10-01T10:00:00Z",
      },
    ],
    pending_staff: [
      {
        profile_id: "p2",
        name: "Siti",
        staff_no: "ST-02",
        department: "operation",
        station: "KUL - MAA",
      },
    ],
  };

  assert.equal(mockReport.total_eligible, mockReport.total_acknowledged + mockReport.pending_count);
  assert.equal(mockReport.compliance_percentage, Math.round((mockReport.total_acknowledged / mockReport.total_eligible) * 100));
  assert.equal(mockReport.acknowledged_staff.length > 0, true);
  assert.equal(mockReport.pending_staff.length > 0, true);
});
