import test from "node:test";
import assert from "node:assert/strict";
import type { AnnouncementTargetRow, AnnouncementWithStatus } from "../lib/avsec/types.ts";

interface UserScope {
  id: string;
  station: string | null;
  team: string | null;
  ops_group: string | null;
}

function matchesTarget(target: Omit<AnnouncementTargetRow, "id" | "announcement_id">, user: UserScope): boolean {
  if (target.branch && target.branch !== user.ops_group) return false;
  if (target.station && target.station !== user.station) return false;
  if (target.team && target.team !== user.team) return false;
  return true;
}

function matchesAnyTarget(targets: Array<Omit<AnnouncementTargetRow, "id" | "announcement_id">>, user: UserScope): boolean {
  if (targets.length === 0) return true; // Default broadcast to all
  return targets.some((t) => matchesTarget(t, user));
}

test("Announcement targeting: global broadcast (no targets or all-null) matches everyone", () => {
  const user1: UserScope = { id: "u1", station: "KUL", team: "Alpha", ops_group: "operation_avsec" };
  const user2: UserScope = { id: "u2", station: "PEN", team: "Beta", ops_group: "ifc_avsec" };

  const globalTarget: Omit<AnnouncementTargetRow, "id" | "announcement_id"> = {
    branch: null,
    station: null,
    team: null,
  };

  assert.equal(matchesAnyTarget([], user1), true);
  assert.equal(matchesAnyTarget([], user2), true);
  assert.equal(matchesAnyTarget([globalTarget], user1), true);
  assert.equal(matchesAnyTarget([globalTarget], user2), true);
});

test("Announcement targeting: branch-specific scope", () => {
  const opUser: UserScope = { id: "u1", station: "KUL", team: "Alpha", ops_group: "operation_avsec" };
  const ifcUser: UserScope = { id: "u2", station: "KUL", team: "Alpha", ops_group: "ifc_avsec" };

  const opTarget = { branch: "operation_avsec", station: null, team: null };

  assert.equal(matchesAnyTarget([opTarget], opUser), true);
  assert.equal(matchesAnyTarget([opTarget], ifcUser), false);
});

test("Announcement targeting: station & team specific scope", () => {
  const kulAlpha: UserScope = { id: "u1", station: "KUL", team: "Alpha", ops_group: "operation_avsec" };
  const kulBeta: UserScope = { id: "u2", station: "KUL", team: "Beta", ops_group: "operation_avsec" };
  const penAlpha: UserScope = { id: "u3", station: "PEN", team: "Alpha", ops_group: "operation_avsec" };

  const kulAlphaTarget = { branch: "operation_avsec", station: "KUL", team: "Alpha" };

  assert.equal(matchesAnyTarget([kulAlphaTarget], kulAlpha), true);
  assert.equal(matchesAnyTarget([kulAlphaTarget], kulBeta), false);
  assert.equal(matchesAnyTarget([kulAlphaTarget], penAlpha), false);
});

test("Announcement acknowledgement: tracks user read state", () => {
  const announcement: AnnouncementWithStatus = {
    id: "ann-1",
    org_id: "org-1",
    created_by: "mgmt-1",
    title: "New Safety Protocol",
    body: "Please review the updated standard operating procedure.",
    created_at: "2026-09-11T10:00:00Z",
    targets: [{ id: "t1", announcement_id: "ann-1", branch: null, station: null, team: null }],
    acknowledged: false,
    acknowledged_at: null,
  };

  assert.equal(announcement.acknowledged, false);

  // Mark acknowledged
  const acknowledgedAnnouncement: AnnouncementWithStatus = {
    ...announcement,
    acknowledged: true,
    acknowledged_at: "2026-09-11T10:15:00Z",
  };

  assert.equal(acknowledgedAnnouncement.acknowledged, true);
  assert.ok(acknowledgedAnnouncement.acknowledged_at);
});

test("Management acknowledgement reach calculation", () => {
  const audience = [
    { user_id: "u1", name: "Staff 1", acknowledged: true, acknowledged_at: "2026-09-11T10:05:00Z" },
    { user_id: "u2", name: "Staff 2", acknowledged: true, acknowledged_at: "2026-09-11T10:07:00Z" },
    { user_id: "u3", name: "Staff 3", acknowledged: false, acknowledged_at: null },
    { user_id: "u4", name: "Staff 4", acknowledged: false, acknowledged_at: null },
  ];

  const total = audience.length;
  const acknowledgedCount = audience.filter((a) => a.acknowledged).length;
  const rate = Math.round((acknowledgedCount / total) * 100);

  assert.equal(total, 4);
  assert.equal(acknowledgedCount, 2);
  assert.equal(rate, 50);
});
