// Phase 8 Round 2 certification: proves, against the REAL
// reviewLeaveApplication() implementation (not a re-derived copy of its
// logic), that an activated Phase 3 reviewer is routed through
// review_leave_request_secure() and CANNOT fall through to the legacy
// race-prone path, while a zero-Phase-3-assignment reviewer still uses
// the documented temporary compatibility path. Only Next.js-runtime
// boundaries (next/cache) and the Supabase client construction
// functions are mocked; the routing decision itself
// (lib/avsec/duty/absence-actions.ts) runs unmodified and un-mocked.
//
// node:test only allows mock.module() to register a given specifier
// ONCE per process (a second call throws ERR_INVALID_STATE) -- so every
// mock below is registered exactly once, at module load, backed by
// mutable state each test reassigns before calling the function under
// test. This is the correct pattern for this API, not a workaround.
import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { ResultQueue, makeMockSupabaseClient } from "./mocks/supabase-query-builder.mts";

function freshProfile(overrides: Record<string, unknown> = {}) {
  return { id: "reviewer-1", role: "ASO", station: "PEN", team: "Alpha", name: "Test Reviewer", ...overrides };
}

let currentProfile: Record<string, unknown> = freshProfile();
let currentQueue = new ResultQueue();
let currentSecureRpcResult: { ok: boolean; error: string | null; data: unknown } = { ok: true, error: null, data: { id: "notice-1", status: "approved" } };
const secureRpcCalls: unknown[][] = [];

mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => makeMockSupabaseClient(currentQueue) } });
mock.module("@/lib/avsec/auth", {
  namedExports: {
    requireProfile: async () => currentProfile,
    getCurrentProfile: async () => currentProfile,
  },
});
mock.module("@/lib/phase8/workforce", {
  namedExports: {
    reviewLeaveRequestSecure: async (...args: unknown[]) => {
      secureRpcCalls.push(args);
      return currentSecureRpcResult;
    },
  },
});

const { reviewLeaveApplication } = await import("../lib/avsec/duty/absence-actions.ts");

function reset(profile: Record<string, unknown>, opts: { secureRpcResult?: typeof currentSecureRpcResult } = {}) {
  currentProfile = profile;
  currentQueue = new ResultQueue();
  currentSecureRpcResult = opts.secureRpcResult ?? { ok: true, error: null, data: { id: "notice-1", status: "approved" } };
  secureRpcCalls.length = 0;
  return currentQueue;
}

test("leave routing: an activated Phase 3 DSE uses review_leave_request_secure(), never the legacy path", async () => {
  const queue = reset(freshProfile({ role: "DSE" }));
  queue.push({ count: 1, error: null }); // active-assignment-count check

  const result = await reviewLeaveApplication({ noticeId: "notice-1", action: "approve" });

  assert.equal(result.success, true);
  assert.equal(secureRpcCalls.length, 1, "review_leave_request_secure() was called exactly once");
  assert.deepEqual(secureRpcCalls[0], ["notice-1", "approve", undefined], "the secure RPC received the exact notice id and action");
  assert.equal(queue.callsMatching("from").length, 1, "only ONE admin-client query ran (the assignment-count check) -- the legacy absence_notices fetch never ran");
});

test("leave routing: an activated Hub SE (Management-rank legacy account with an active Phase 3 assignment) uses the secure RPC", async () => {
  const queue = reset(freshProfile({ role: "MANAGEMENT" }));
  queue.push({ count: 1, error: null });
  const result = await reviewLeaveApplication({ noticeId: "notice-2", action: "approve" });
  assert.equal(result.success, true);
  assert.equal(secureRpcCalls.length, 1);
});

test("leave routing: an activated Operation Manager (org-wide legacy rank) uses the secure RPC for reject too", async () => {
  const queue = reset(freshProfile({ role: "MANAGEMENT" }));
  queue.push({ count: 1, error: null });
  await reviewLeaveApplication({ noticeId: "notice-3", action: "reject" });
  assert.equal(secureRpcCalls.length, 1, "reject also routes through the secure RPC for an activated account");
});

test("leave routing: an activated Main Enforcement (org-wide legacy rank) uses the secure RPC", async () => {
  const queue = reset(freshProfile({ role: "ENFORCEMENT" }));
  queue.push({ count: 1, error: null });
  await reviewLeaveApplication({ noticeId: "notice-4", action: "approve" });
  assert.equal(secureRpcCalls.length, 1);
});

test("leave routing: a reviewer with ZERO active Phase 3 assignments uses the documented legacy compatibility path", async () => {
  const queue = reset(freshProfile({ role: "DSE" }));
  queue.push({ count: 0, error: null });
  queue.push({
    data: { id: "notice-5", station: "PEN", team: "Alpha", user_id: "staff-1", staff_name: "x", leave_type: "mc", start_date: "2027-01-01", end_date: "2027-01-01", approval_status: "pending" },
    error: null,
  });
  queue.push({ error: null }); // legacy update

  const result = await reviewLeaveApplication({ noticeId: "notice-5", action: "approve" });

  assert.equal(secureRpcCalls.length, 0, "the secure RPC is never called for a zero-assignment legacy reviewer");
  assert.equal(result.success, true, "the legacy compatibility path still completes the review");
});

test("leave routing: cancellation actions always use the legacy path (no Phase 8 RPC covers cancellation, regardless of activation)", async () => {
  const queue = reset(freshProfile({ role: "DSE" }));
  queue.push({
    data: { id: "notice-6", station: "PEN", team: "Alpha", user_id: "staff-1", staff_name: "x", leave_type: "mc", start_date: "2027-01-01", end_date: "2027-01-01", approval_status: "pending_cancellation" },
    error: null,
  });
  queue.push({ error: null });

  const result = await reviewLeaveApplication({ noticeId: "notice-6", action: "approve_cancellation" });

  assert.equal(secureRpcCalls.length, 0, "a cancellation action never calls the secure RPC (it only covers approve/reject)");
  assert.equal(result.success, true);
});

test("leave routing: an unauthorized role (plain ASO, no DSE/org-wide rank) is denied before any query runs", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  const result = await reviewLeaveApplication({ noticeId: "notice-7", action: "approve" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Only DSE or Management/);
  assert.equal(queue.getCalls().length, 0, "no database query ran at all for an unauthorized caller");
});

test("leave routing: the active-assignment query itself excludes revoked, expired and not-yet-started assignments (revoked_at is null, starts_at <= now, ends_at is null OR ends_at > now)", async () => {
  // This proves the APPLICATION CODE asks the database the right
  // question -- that revoked/expired/future assignments don't count as
  // "active" is then enforced by Postgres itself (proven separately by
  // the real database in supabase/tests/integration). A mock cannot
  // re-verify Postgres's own row-filtering semantics; what it CAN prove,
  // and what this test proves, is that absence-actions.ts constructs
  // exactly the filter chain that encodes "revoked, expired and
  // not-yet-started don't count" -- not some looser or different query.
  const queue = reset(freshProfile({ role: "DSE" }));
  queue.push({ count: 1, error: null });
  await reviewLeaveApplication({ noticeId: "notice-9", action: "approve" });

  const isCalls = queue.callsMatching("is");
  assert.ok(isCalls.some((c) => c.args[1] === "revoked_at" && c.args[2] === null), "the query filters out revoked assignments (revoked_at is null)");

  const lteCalls = queue.callsMatching("lte");
  assert.ok(lteCalls.some((c) => c.args[1] === "starts_at"), "the query filters out not-yet-started (future/pending) assignments (starts_at <= now)");

  const orCalls = queue.callsMatching("or");
  assert.ok(orCalls.some((c) => typeof c.args[1] === "string" && c.args[1].startsWith("ends_at.is.null,ends_at.gt.")), "the query filters out expired assignments (ends_at is null OR ends_at > now)");
});

test("leave routing: the secure RPC's own denial (e.g. department separation) propagates as a failure, not a silent success", async () => {
  const queue = reset(freshProfile({ role: "MANAGEMENT" }), {
    secureRpcResult: { ok: false, error: "No active Phase 3 role assignment grants authority to review this Enforcement leave request.", data: null },
  });
  queue.push({ count: 1, error: null });
  const result = await reviewLeaveApplication({ noticeId: "notice-8", action: "approve" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /No active Phase 3 role assignment/);
});
