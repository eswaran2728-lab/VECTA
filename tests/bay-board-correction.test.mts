import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000005_bay_board_controlled_correction.sql", "utf8");
const actions = fs.readFileSync("lib/avsec/reports/actions.ts", "utf8");
const list = fs.readFileSync("components/avsec/bay-board/BayBoardList.tsx", "utf8");

test("no client write path can clear a Bay Board entry any more", () => {
  assert.doesNotMatch(actions, /export async function clearBayBoardEntry/);
  assert.doesNotMatch(actions, /\.from\("bay_board"\)\s*\.update\(\{\s*cleared_at: new Date\(\)\.toISOString\(\) \}\)/);
  assert.doesNotMatch(list, /clearBayBoardEntry/);
  assert.match(sql, /drop policy if exists "bay_board_scoped_update"/);
  assert.match(sql, /revoke update on public\.bay_board from authenticated/);
  assert.match(sql, /revoke insert on public\.bay_board from authenticated/);
  assert.match(sql, /grant insert \(station, reg_no, aircraft_type, bay, flight, arrival_report_id, on_ground_since, is_manual, created_by, towed_from_hangar\)/);
  assert.doesNotMatch(sql, /grant insert \([^)]*cleared/);
});

test("the correction is the only manual path: reason, authority, audit, and never recorded as a normal clear or a confirmed search", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.correct_bay_board_entry_secure"));
  assert.match(fn, /char_length\(v_reason\) < 10/);
  assert.match(fn, /rd\.code in \('so', 'sso', 'dse'\)/);
  assert.match(fn, /has_active_role_for_aoc\('operation_manager'/);
  assert.match(fn, /for update/);
  assert.match(fn, /cleared_kind = 'correction'/);
  assert.match(fn, /cleared_by_report_id = null/);
  assert.match(fn, /search_state = case when v_required then 'exception'/);
  assert.doesNotMatch(fn, /search_state = 'confirmed'/);
  assert.match(fn, /insert into public\.bay_board_corrections/);
  assert.match(fn, /phase8_write_audit\('bay_board_corrected'/);
  assert.match(fn, /phase8_write_audit\('bay_board_correction_refused'/);
});

test("an aircraft that still needs a search can only be corrected by a DSE or the Operation Manager, never by its own creator, and leaves an exception for review", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.correct_bay_board_entry_secure"));
  assert.match(fn, /not \(v_is_om or v_role = 'dse'\)/);
  assert.match(fn, /NEEDS_DSE/);
  assert.match(fn, /b\.created_by = v_caller/);
  assert.match(fn, /OWN_ENTRY/);
  assert.match(fn, /insert into public\.aircraft_search_records/);
  assert.match(fn, /'exception'/);
});

test("the correction function is security definer, fixed search_path, revoked from anon", () => {
  assert.match(sql, /security definer\s+set search_path to 'public'/);
  assert.match(sql, /revoke execute on function public\.correct_bay_board_entry_secure\(uuid, text\) from public, anon/);
});

test("the Bay Board UI asks for a reason and describes the entry as corrected, not completed", () => {
  assert.match(list, /correctBayBoardEntry/);
  assert.match(list, /at least 10 characters/);
  assert.match(list, /recorded as a correction, not as a completed search/);
});
