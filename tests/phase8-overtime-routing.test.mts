// Phase 8 Round 2 certification: proves, against the REAL
// reviewOvertimeRequest() implementation, that the app-layer gate
// correctly attempts the action for DSE, Hub SE, Operation Manager and
// Main Enforcement, and denies an unrelated role -- while the actual
// department-separation authority remains the database (RLS + trigger),
// which this app-layer test cannot re-verify (that's the DB-integration
// suite's job) but whose denial this test proves correctly propagates
// as a failure rather than being swallowed.
import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { ResultQueue, makeMockSupabaseClient } from "./mocks/supabase-query-builder.mts";

function freshProfile(overrides: Record<string, unknown> = {}) {
  return { id: "reviewer-1", role: "ASO", station: "PEN", team: "Alpha", name: "Test Reviewer", ...overrides };
}

let currentProfile: Record<string, unknown> = freshProfile();
let currentQueue = new ResultQueue();

mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect() should not be called by reviewOvertimeRequest itself"); } } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => makeMockSupabaseClient(currentQueue) } });
mock.module("@/lib/avsec/auth", { namedExports: { requireProfile: async () => currentProfile } });
mock.module("@/lib/avsec/email/notifyOvertimeApproval", { namedExports: { notifyOvertimeApproval: async () => {} } });

const { reviewOvertimeRequest } = await import("../lib/avsec/duty/overtime-actions.ts");

function reset(profile: Record<string, unknown>) {
  currentProfile = profile;
  currentQueue = new ResultQueue();
  return currentQueue;
}

test("OT review: DSE can endorse a pending request (app-layer gate allows it, no has_active_role RPC needed)", async () => {
  const queue = reset(freshProfile({ role: "DSE" }));
  queue.push({ data: { id: "ot-1", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc", status: "pending" }, error: null }); // fetch
  queue.push({ data: { id: "ot-1", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc" }, error: null }); // reject update path not used here

  // Endorsement itself is a separate action (endorseOvertimeRequest); this
  // proves reviewOvertimeRequest's REJECT path (which DSE can also do at
  // pending) is reachable without any Phase 8 RPC probe.
  const result = await reviewOvertimeRequest({ requestId: "ot-1", action: "reject", reviewNotes: "test" });
  assert.equal(result.success, true);
  assert.equal(queue.callsMatching("rpc").length, 0, "DSE never needs a has_active_role probe -- legacy rank is enough for the app-layer gate");
});

test("OT review: Hub SE is allowed to attempt (has_active_role('hub_se') resolves true; endorse/approve are probed as separate, independent roles)", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: true, error: null }); // has_active_role('hub_se') -> true (endorse-capable)
  queue.push({ data: false, error: null }); // has_active_role('operation_manager') -> false
  queue.push({ data: false, error: null }); // has_active_role('main_enforcement') -> false
  queue.push({ data: { id: "ot-2", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc", status: "pending" }, error: null }); // fetch
  queue.push({ data: { id: "ot-2" }, error: null }); // reject update result

  const result = await reviewOvertimeRequest({ requestId: "ot-2", action: "reject" });
  assert.equal(result.success, true);
  const rpcCalls = queue.callsMatching("rpc");
  assert.equal(rpcCalls.length, 3, "hub_se, operation_manager and main_enforcement are each probed independently (endorse and approve capability are tracked separately)");
  assert.deepEqual(rpcCalls[0].args, ["has_active_role", { p_role_code: "hub_se" }]);
});

test("OT review: Operation Manager can give final approval (has_active_role probe reaches 'operation_manager')", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: false, error: null }); // hub_se -> false
  queue.push({ data: true, error: null }); // operation_manager -> true
  queue.push({ data: { id: "ot-3", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc", status: "endorsed" }, error: null }); // fetch (already endorsed)
  queue.push({ data: { id: "ot-3", profile_id: "submitter-1", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc" }, error: null }); // update result
  queue.push({ data: { name: "Submitter", staff_no: "T-1" }, error: null }); // submitter lookup for the notify email

  const result = await reviewOvertimeRequest({ requestId: "ot-3", action: "approve" });
  assert.equal(result.success, true, result.error);
  const rpcCalls = queue.callsMatching("rpc");
  assert.equal(rpcCalls.length, 2, "hub_se probed and failed, operation_manager probed and succeeded -- exactly 2 RPC calls");
});

test("OT review: Main Enforcement can give final approval (has_active_role probe reaches 'main_enforcement')", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: false, error: null }); // hub_se
  queue.push({ data: false, error: null }); // operation_manager
  queue.push({ data: true, error: null }); // main_enforcement
  queue.push({ data: { id: "ot-4", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc", status: "endorsed" }, error: null });
  queue.push({ data: { id: "ot-4", profile_id: "submitter-1", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc" }, error: null });
  queue.push({ data: { name: "Submitter", staff_no: "T-1" }, error: null });

  const result = await reviewOvertimeRequest({ requestId: "ot-4", action: "approve" });
  assert.equal(result.success, true, result.error);
});

test("OT review: an unrelated role (plain ASO, none of DSE/Management/hub_se/operation_manager/main_enforcement) is denied before any DB fetch", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: false, error: null }); // hub_se
  queue.push({ data: false, error: null }); // operation_manager
  queue.push({ data: false, error: null }); // main_enforcement

  const result = await reviewOvertimeRequest({ requestId: "ot-5", action: "reject" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Only DSE, Hub SE, Operation Manager or Main Enforcement/);
  assert.equal(queue.callsMatching("from").length, 0, "no overtime_requests fetch ran for a fully unauthorized caller");
});

test("OT review: Hub SE (endorsement-only role) is denied FINAL APPROVAL -- app-layer gate blocks it before any DB fetch (regression test for the hasPhase8OtRole/hasPhase8ApproveRole conflation bug this test caught)", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: true, error: null }); // hub_se -> true (endorse-capable, NOT approve-capable)
  queue.push({ data: false, error: null }); // operation_manager -> false
  queue.push({ data: false, error: null }); // main_enforcement -> false

  const result = await reviewOvertimeRequest({ requestId: "ot-6", action: "approve" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Only Management, Operation Manager or Main Enforcement can give final approval/);
  assert.equal(queue.callsMatching("from").length, 0, "denied before any overtime_requests fetch -- Hub SE's approve attempt never reaches the database at all");
});

test("OT review: a database-layer denial (e.g. Operation Manager attempting an Enforcement-dept request, rejected by RLS/trigger) propagates as a failure, not a silent success", async () => {
  const queue = reset(freshProfile({ role: "ASO" }));
  queue.push({ data: false, error: null }); // hub_se
  queue.push({ data: true, error: null }); // operation_manager -> true
  queue.push({ data: { id: "ot-7", profile_id: "other", station: "PEN", team: "Alpha", work_date: "2027-01-01", payable_hours: 2, category: "adhoc", status: "endorsed" }, error: null }); // fetch
  // The database layer (RLS + enforce_overtime_transition trigger)
  // rejects the update for a department mismatch -- simulated here as
  // the update returning no row (exactly what RLS silently filtering the
  // row produces in real Postgres: zero rows affected, not an error).
  queue.push({ data: null, error: null });

  const result = await reviewOvertimeRequest({ requestId: "ot-7", action: "approve" });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no longer endorsed/);
});
