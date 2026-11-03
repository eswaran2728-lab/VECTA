import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000002_leave_unpaid_routing_and_cancellation.sql", "utf8");

test("unpaid routing is derived from the applicant's inclusive days and entity, never a parameter", () => {
  assert.match(sql, /v_days := \(v_notice\.end_date - v_notice\.start_date\) \+ 1/);
  assert.match(sql, /if v_days <= 2 then/);
  assert.match(sql, /leave_submitter_entity\(v_notice\.user_id\)/);
  assert.match(sql, /lower\(v_entity\) \|\| '_boss'/);
  assert.doesNotMatch(sql, /p_role|p_entity|p_route/);
});

test("overlap exception is judged per day and recorded at approval; only the Operation Manager may approve it", () => {
  assert.match(sql, /generate_series\(p_start/);
  assert.match(sql, /v_peak >= 3/);
  assert.match(sql, /overlap_exception = case when v_new_status = 'approved' then v_exception/);
  assert.match(sql, /not v_is_operation_manager then\s+raise exception 'Team Annual Leave capacity reached/);
});

test("direct cancellation: reason required, own-team DSE or recorded-exception Operation Manager, Malaysia-date release, no repeat, audited and notified", () => {
  assert.match(sql, /char_length\(v_reason\) < 5/);
  assert.match(sql, /not v_notice\.overlap_exception/);
  assert.match(sql, /Asia\/Kuala_Lumpur/);
  assert.match(sql, /Completed leave cannot be cancelled/);
  assert.match(sql, /No days remain after today to release/);
  assert.match(sql, /has already been cancelled/);
  assert.match(sql, /v_notice\.user_id = v_caller/);
  assert.match(sql, /phase8_write_audit\('leave_cancelled_directly'/);
  assert.match(sql, /_cancelled'/);
  assert.match(sql, /end_date = case when v_kind = 'partial' then v_today else end_date end/);
  assert.match(sql, /revoke execute on function public\.cancel_approved_leave_secure\(uuid, text\) from public, anon/);
});
