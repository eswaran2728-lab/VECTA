import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { leaveRpcArgs, mapLeaveRpcResult, GENERIC_LEAVE_ERROR } from "../lib/avsec/duty/leave-submit.ts";

const ROW = {
  notice_id: "00000000-0000-0000-0000-000000000001",
  result_approval_status: "pending",
  result_status: "green",
  result_gap_minutes: 190,
  result_formatted_gap: "Requested 3h 10m before shift",
  result_submitted_at: "2026-10-14T01:00:00.000Z",
  result_start_date: "2026-10-14",
  result_end_date: "2026-10-14",
  result_leave_type: "mc",
  result_same_day: true,
  result_shift_code: "M",
};

test("a successful RPC result keeps the response contract the UI already uses", () => {
  const r = mapLeaveRpcResult([ROW], null);
  assert.deepEqual(r, {
    error: null, success: true, leaveType: "mc", startDate: "2026-10-14", endDate: "2026-10-14", approvalStatus: "pending",
    status: "green", formattedGap: "Requested 3h 10m before shift", submittedAt: "2026-10-14T01:00:00.000Z",
  });
});

test("a database refusal we wrote (SQLSTATE P0001) is shown; any other error is replaced by a generic message", () => {
  const ours = mapLeaveRpcResult(null, { code: "P0001", message: "You have already submitted a leave application for today's shift." });
  assert.equal(ours.success, false);
  assert.equal(ours.error, "You have already submitted a leave application for today's shift.");
  for (const message of ['insert or update on table "duty_records" violates foreign key constraint "duty_records_station_fkey"', "permission denied for table duty_records", "deadlock detected", "connection terminated"]) {
    const r = mapLeaveRpcResult(null, { code: "23503", message });
    assert.equal(r.success, false);
    assert.equal(r.error, GENERIC_LEAVE_ERROR);
    assert.equal(r.error?.includes("duty_records"), false);
  }
});

test("an empty or malformed RPC result is a failure, never a reported success", () => {
  for (const data of [null, undefined, [], [{}], [{ notice_id: null }]]) {
    const r = mapLeaveRpcResult(data as never, null);
    assert.equal(r.success, false, JSON.stringify(data));
    assert.equal(r.error, GENERIC_LEAVE_ERROR);
  }
});

test("only the leave type, the dates and the remarks are sent; identity, station and team never come from the client", () => {
  assert.deepEqual(leaveRpcArgs({ leaveType: "annual", startDate: "2026-10-20", endDate: "2026-10-22", remarks: "  trip " }), {
    p_leave_type: "annual", p_start_date: "2026-10-20", p_end_date: "2026-10-22", p_remarks: "trip",
  });
  assert.deepEqual(leaveRpcArgs({ remarks: "x" }), { p_leave_type: "absent", p_start_date: undefined, p_end_date: undefined, p_remarks: "x" });
});

test("the action submits through the RPC only: no service-role client, no direct absence_notices or duty_records write", () => {
  const src = fs.readFileSync("lib/avsec/duty/absence-actions.ts", "utf8");
  const submit = src.slice(src.indexOf("export async function submitLeaveApplication("), src.indexOf("export async function submitAbsenceNotice("));
  assert.match(submit, /rpc\(\s*"submit_leave_application_secure"/);
  assert.doesNotMatch(submit, /createAdminClient|\.from\("absence_notices"\)|\.from\("duty_records"\)|\.upsert\(/);
  assert.doesNotMatch(submit, /console\.warn\("\[submitLeaveApplication\] duty_records update note/, "the duty write error is no longer swallowed");
  assert.match(submit, /getAttendanceProfile\(\)/, "non-rostered leadership is still denied before the call");
});

test("the migration closes the direct client insert path and is the RPC's only creator of notices", () => {
  const sql = fs.readFileSync("supabase/migrations/20261109000001_atomic_same_day_leave.sql", "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /drop policy if exists absence_notices_insert_own on public\.absence_notices/);
  assert.match(sql, /revoke insert on public\.absence_notices from public, anon, authenticated/);
  assert.match(sql, /revoke execute on function public\.submit_leave_application_secure\(text, date, date, text\) from public, anon/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /for update/);
});
