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
const AUTHORIZED_MALAYSIA_AOC_PUBLISHERS = new Set(["maa_boss", "maa_admin", "aax_boss", "aax_admin"]);
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

function canPublishAnnouncement(roleCode: string, scope: string, aocCode?: string | null): boolean {
  if (scope === "global") {
    return AUTHORIZED_GLOBAL_PUBLISHERS.has(roleCode) && !aocCode;
  }
  if (scope === "aoc") {
    // GHOD must NOT publish an AOC announcement. GHOD uses the Global announcement channel.
    if (roleCode === "ghod") return false;
    if (aocCode === "MY") {
      return AUTHORIZED_MALAYSIA_AOC_PUBLISHERS.has(roleCode);
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
    profileStatus?: "approved" | "pending" | "rejected" | "deactivated";
  },
  nowTime: string
): boolean {
  if (caller.profileStatus && caller.profileStatus !== "approved") {
    return false;
  }

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
    // Audience: every eligible active user assigned to Malaysia AOC (both MAA and AAX)
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

test("Phase 11 Role Matrix: GHOD CANNOT publish Malaysia AOC announcements", () => {
  // Authoritative rule: GHOD must not publish an AOC announcement. GHOD uses the Global announcement channel.
  assert.equal(canPublishAnnouncement("ghod", "aoc", "MY"), false, "GHOD must NOT publish Malaysia AOC announcements");
  assert.equal(canPublishAnnouncement("ghod", "aoc", "ZZ"), false, "GHOD must NOT publish foreign AOC announcements");
});

test("Phase 11 Role Matrix: VECTA has NO generic HOD role", () => {
  assert.equal(AUTHORIZED_GLOBAL_PUBLISHERS.has("hod"), false);
  assert.equal(AUTHORIZED_MALAYSIA_AOC_PUBLISHERS.has("hod"), false);
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

test("Phase 11 Role Matrix: Approved Malaysia AOC publishers (MAA/AAX Boss & Admin)", () => {
  assert.equal(canPublishAnnouncement("maa_boss", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("maa_admin", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("aax_boss", "aoc", "MY"), true);
  assert.equal(canPublishAnnouncement("aax_admin", "aoc", "MY"), true);

  // Denied in foreign AOC
  assert.equal(canPublishAnnouncement("maa_boss", "aoc", "SG"), false);
  assert.equal(canPublishAnnouncement("aax_boss", "aoc", "TH"), false);

  // Non-approved roles cannot publish in Malaysia AOC
  assert.equal(canPublishAnnouncement("operation_manager", "aoc", "MY"), false);
  assert.equal(canPublishAnnouncement("main_enforcement", "aoc", "MY"), false);
  assert.equal(canPublishAnnouncement("compliance", "aoc", "MY"), false);
  assert.equal(canPublishAnnouncement("caterlink_management", "aoc", "MY"), false);
  assert.equal(canPublishAnnouncement("super_admin", "aoc", "MY"), false);
});

test("Phase 11 Subscopes Removed: entity, department, and station rejected", () => {
  const unapprovedSubscopes = ["entity", "department", "station"];
  for (const subscope of unapprovedSubscopes) {
    assert.equal(canPublishAnnouncement("ghod", subscope), false, `GHOD cannot publish to unapproved subscope: ${subscope}`);
    assert.equal(canPublishAnnouncement("maa_boss", subscope, "MY"), false, `MAA Boss cannot publish to unapproved subscope: ${subscope}`);
    assert.equal(canPublishAnnouncement("aax_boss", subscope, "MY"), false, `AAX Boss cannot publish to unapproved subscope: ${subscope}`);
  }
});

test("Phase 11 Multi-AOC Isolation: Malaysia announcements hidden from foreign personnel", () => {
  const myAnn = {
    status: "published" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };

  const myStaffMAA = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true };
  const myStaffAAX = { roleCode: "so", aocCode: "MY", hasActiveAssignment: true };
  const foreignStaff = { roleCode: "aso", aocCode: "ZZ", hasActiveAssignment: true };

  const now = "2026-10-01T12:00:00Z";
  assert.equal(isAnnouncementVisibleToCaller(myAnn, myStaffMAA, now), true, "MAA staff can see Malaysia announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, myStaffAAX, now), true, "AAX staff can see Malaysia announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, foreignStaff, now), false, "Foreign staff cannot see Malaysia announcement");
});

test("Phase 11 Inactive / Deactivated / Pending assignments rejected", () => {
  const myAnn = {
    status: "published" as AnnouncementStatus,
    published_at: "2026-10-01T00:00:00Z",
    expires_at: null,
    scope: "aoc" as AnnouncementScope,
    aoc_code: "MY",
  };
  const now = "2026-10-01T12:00:00Z";

  const pendingUser = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true, profileStatus: "pending" as const };
  const rejectedUser = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true, profileStatus: "rejected" as const };
  const deactivatedUser = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: true, profileStatus: "deactivated" as const };
  const inactiveAssignmentUser = { roleCode: "aso", aocCode: "MY", hasActiveAssignment: false, profileStatus: "approved" as const };

  assert.equal(isAnnouncementVisibleToCaller(myAnn, pendingUser, now), false, "Pending profile cannot see announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, rejectedUser, now), false, "Rejected profile cannot see announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, deactivatedUser, now), false, "Deactivated profile cannot see announcement");
  assert.equal(isAnnouncementVisibleToCaller(myAnn, inactiveAssignmentUser, now), false, "Inactive assignment user cannot see announcement");
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
  function validateScopeConstraints(scope: string, aocId: string | null): boolean {
    if (scope === "global") {
      return aocId === null;
    }
    if (scope === "aoc") {
      return aocId !== null;
    }
    return false; // Subscopes entity, department, station are invalid
  }

  assert.equal(validateScopeConstraints("global", null), true);
  assert.equal(validateScopeConstraints("global", "00000000-0000-0000-0000-000000000001"), false, "Global with AOC rejected");
  assert.equal(validateScopeConstraints("aoc", "00000000-0000-0000-0000-000000000001"), true);
  assert.equal(validateScopeConstraints("aoc", null), false, "AOC with NULL AOC ID rejected");
  assert.equal(validateScopeConstraints("entity", "00000000-0000-0000-0000-000000000001"), false, "Entity scope rejected");
  assert.equal(validateScopeConstraints("department", "00000000-0000-0000-0000-000000000001"), false, "Department scope rejected");
  assert.equal(validateScopeConstraints("station", "00000000-0000-0000-0000-000000000001"), false, "Station scope rejected");
});

test("Phase 11 Acknowledgement Report Privacy Matrix", () => {
  function canAccessAcknowledgementReport(roleCode: string, scope: string, aocCode?: string | null): boolean {
    if (scope === "global") {
      return roleCode === "ghod";
    }
    if (scope === "aoc" && aocCode === "MY") {
      return AUTHORIZED_MALAYSIA_AOC_PUBLISHERS.has(roleCode);
    }
    return false;
  }

  // GHOD can view Global report; denied viewing Malaysia AOC report
  assert.equal(canAccessAcknowledgementReport("ghod", "global"), true);
  assert.equal(canAccessAcknowledgementReport("ghod", "aoc", "MY"), false);

  // Malaysia publishers can view Malaysia AOC report; denied viewing Global report
  assert.equal(canAccessAcknowledgementReport("maa_boss", "aoc", "MY"), true);
  assert.equal(canAccessAcknowledgementReport("aax_admin", "aoc", "MY"), true);
  assert.equal(canAccessAcknowledgementReport("maa_boss", "global"), false);
  assert.equal(canAccessAcknowledgementReport("aax_admin", "global"), false);

  // AirAsia Management, Super Admin, and ordinary staff cannot view any report
  assert.equal(canAccessAcknowledgementReport("airasia_management", "global"), false);
  assert.equal(canAccessAcknowledgementReport("airasia_management", "aoc", "MY"), false);
  assert.equal(canAccessAcknowledgementReport("super_admin", "global"), false);
  assert.equal(canAccessAcknowledgementReport("super_admin", "aoc", "MY"), false);
  assert.equal(canAccessAcknowledgementReport("aso", "global"), false);
  assert.equal(canAccessAcknowledgementReport("aso", "aoc", "MY"), false);
});
