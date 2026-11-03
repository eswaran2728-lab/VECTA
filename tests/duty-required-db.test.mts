import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000006_duty_required_for_submission_and_physical_work.sql", "utf8");
const read = (f: string) => fs.readFileSync(f, "utf8");

test("every security report table refuses a submitted row without an open check-in, by a direct request", () => {
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "report_makeup", "report_breakup"]) {
    assert.match(sql, new RegExp(`create trigger trg_report_submit_requires_open_duty before insert or update of status on public\\.${t} for each row`), t);
  }
  const fn = sql.slice(sql.indexOf("create or replace function public.report_submit_requires_open_duty"), sql.indexOf("revoke execute on function public.report_submit_requires_open_duty"));
  assert.match(fn, /auth\.uid\(\) is null then\s+return new/, "service-side writes with no signed-in user are not blocked");
  assert.match(fn, /new\.status::text is distinct from 'submitted'/, "drafts and preparation are not blocked");
  assert.match(fn, /check_in_at is not null\s+and d\.check_out_at is null/);
  assert.match(fn, /Asia\/Kuala_Lumpur/);
  assert.match(fn, /raise exception 'You must check in for duty before submitting a report\.'/);
});

test("finishing an aircraft search needs an open check-in, like starting it", () => {
  const f = sql.slice(sql.indexOf("create or replace function public.finish_aircraft_search_secure"));
  assert.match(f, /handover_open_duty\(v_caller, r\.station\) is null then raise exception 'You must be checked in for duty/);
});

test("the middleware no longer redirects off-duty staff, and the account/role/entity gates are still in force", () => {
  const m = read("lib/supabase/middleware.ts");
  assert.doesNotMatch(m, /duty_records/);
  assert.match(m, /pending-approval|status/);
  assert.match(m, /isAdminPathForbiddenFor/);
  assert.match(m, /isOperationalPathForbiddenForSuperAdmin/);
  assert.match(m, /isMainEnforcementPathForbidden/);
});

test("saving a report draft does not depend on being on duty", () => {
  const drafts = read("lib/avsec/reports/drafts.ts");
  assert.doesNotMatch(drafts, /hasOpenDutyCheckIn|ensureCheckedIn|duty_records/);
});

test("the server actions that do physical work or submit still carry their own check-in check", () => {
  assert.equal((read("lib/avsec/reports/actions.ts").match(/await ensureCheckedIn\(profile\.id\)/g) ?? []).length, 8);
  assert.match(read("lib/icms/checkpoint-duty.ts"), /hasOpenDutyCheckIn/);
  assert.match(read("lib/icms/actions/scan.ts"), /hasOpenDutyCheckIn/);
});

test("the staff-facing notes say staff are not locked out", () => {
  const doc = read("docs/operations/staff-access-and-duty.md");
  assert.match(doc, /without checking in|before you check in/i);
  assert.match(doc, /Check in to submit/);
  assert.doesNotMatch(read("docs/PRODUCTION_OPERATIONS_RUNBOOK.md"), /locked out of AVSEC modules with check-in gate prompt/);
});
