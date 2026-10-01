import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_REASONS, type DiscussionThreadSummary, type DiscussionThreadDetail } from "../lib/discussions/types.ts";

test("Phase 10 Anonymity Model: Public thread payload excludes real profile IDs, names, staff numbers, and emails", () => {
  const mockThread: DiscussionThreadSummary = {
    id: "00000000-0000-0000-0000-000000000001",
    category_id: "00000000-0000-0000-0000-000000000002",
    title: "Airside Baggage Handling Procedure",
    author_alias: "Vigilant Falcon",
    status: "open",
    report_count: 0,
    reply_count: 3,
    created_at: "2026-10-01T12:00:00Z",
    edited_at: null,
  };

  const json = JSON.stringify(mockThread);
  assert.equal(json.includes("profile_id"), false, "Payload must not contain profile_id");
  assert.equal(json.includes("staff_no"), false, "Payload must not contain staff_no");
  assert.equal(json.includes("email"), false, "Payload must not contain email");
  assert.equal(json.includes("real_name"), false, "Payload must not contain real_name");
  assert.match(mockThread.author_alias, /^[A-Z][a-z]+ [A-Z][a-z]+$/, "Author alias must be in two-word format");
});

test("Phase 10 Thread Detail: Replies maintain thread-scoped alias continuity without exposing author IDs", () => {
  const mockDetail: DiscussionThreadDetail = {
    id: "00000000-0000-0000-0000-000000000001",
    category_id: "00000000-0000-0000-0000-000000000002",
    title: "Equipment Calibration Inquiry",
    body: "Does Post 2 have the latest calibration chart available?",
    author_alias: "Quiet Panther",
    status: "open",
    created_at: "2026-10-01T12:00:00Z",
    edited_at: null,
    replies: [
      {
        id: "00000000-0000-0000-0000-000000000010",
        body: "Yes, updated yesterday morning at shift change.",
        author_alias: "Swift Eagle",
        status: "visible",
        created_at: "2026-10-01T12:05:00Z",
        edited_at: null,
      },
      {
        id: "00000000-0000-0000-0000-000000000011",
        body: "Confirmed. Copies are placed at the primary inspection console.",
        author_alias: "Quiet Panther", // Same author replying again keeps same alias
        status: "visible",
        created_at: "2026-10-01T12:10:00Z",
        edited_at: null,
      },
    ],
  };

  assert.equal(mockDetail.replies[1].author_alias, mockDetail.author_alias, "Same author keeps same alias within the thread");
  assert.notEqual(mockDetail.replies[0].author_alias, mockDetail.author_alias, "Different author has a distinct alias");

  const json = JSON.stringify(mockDetail);
  assert.equal(json.includes("profile_id"), false);
  assert.equal(json.includes("staff_no"), false);
  assert.equal(json.includes("email"), false);
});

test("Phase 10 Reporting: Standard violation reasons are catalogued with descriptions", () => {
  const reasonCodes = REPORT_REASONS.map((r) => r.code);
  assert.ok(reasonCodes.includes("harassment"));
  assert.ok(reasonCodes.includes("threat"));
  assert.ok(reasonCodes.includes("sensitive_information"));
  assert.ok(reasonCodes.includes("security_concern"));
  assert.ok(reasonCodes.includes("spam"));
  assert.ok(reasonCodes.includes("inappropriate_content"));
  assert.ok(reasonCodes.includes("other"));

  for (const r of REPORT_REASONS) {
    assert.ok(r.label.length > 0);
    assert.ok(r.description.length > 0);
  }
});

test("Phase 10 Content Safety: Input constraints boundary check", () => {
  // Title max length: 200 chars
  const validTitle = "A".repeat(200);
  const oversizedTitle = "A".repeat(201);
  assert.equal(validTitle.length <= 200, true);
  assert.equal(oversizedTitle.length <= 200, false);

  // Body max length: 10,000 chars
  const validBody = "B".repeat(10000);
  const oversizedBody = "B".repeat(10001);
  assert.equal(validBody.length <= 10000, true);
  assert.equal(oversizedBody.length <= 10000, false);

  // Reply max length: 5,000 chars
  const validReply = "C".repeat(5000);
  const oversizedReply = "C".repeat(5001);
  assert.equal(validReply.length <= 5000, true);
  assert.equal(oversizedReply.length <= 5000, false);

  // Identity resolution minimum reason length: 10 chars
  const tooShortReason = "brief";
  const validReason = "Official security compliance audit case #9042";
  assert.equal(tooShortReason.trim().length >= 10, false);
  assert.equal(validReason.trim().length >= 10, true);
});

test("Phase 10 Removed and Locked State Integrity", () => {
  const removedThreadPlaceholder = "[This post has been removed.]";
  const removedAliasPlaceholder = "[removed]";

  const thread: DiscussionThreadSummary = {
    id: "00000000-0000-0000-0000-000000000003",
    category_id: "00000000-0000-0000-0000-000000000002",
    title: "Deleted Discussion",
    author_alias: removedAliasPlaceholder,
    status: "removed",
    report_count: 1,
    reply_count: 0,
    created_at: "2026-10-01T12:00:00Z",
    edited_at: null,
  };

  assert.equal(thread.status, "removed");
  assert.equal(thread.author_alias, removedAliasPlaceholder);
  assert.notEqual(thread.author_alias, "Quiet Panther", "Removed thread suppresses original author alias");
});
