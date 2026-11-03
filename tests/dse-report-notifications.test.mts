import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000003_dse_report_notifications.sql", "utf8");
const bell = fs.readFileSync("components/layout/NotificationsBell.tsx", "utf8");

test("every submitted report type except retired Offload has an after-insert notification trigger", () => {
  for (const t of ["report_sec013", "report_sec014", "report_sec016", "report_sec018", "report_sec029", "report_sec033", "report_makeup", "report_breakup"]) {
    assert.match(sql, new RegExp(`create trigger trg_notify_dse_of_report after insert on public\.${t} for each row`), t);
  }
  assert.doesNotMatch(sql, /on public.report_offload/);
  assert.match(sql, /\(j ->> 'status'\) is distinct from 'submitted'/);
});

test("recipients are active approved DSEs of the same entity, station and team, never the submitter", () => {
  assert.match(sql, /rd\.code = 'dse'/);
  assert.match(sql, /m\.operating_entity_id = v_entity_id/);
  assert.match(sql, /m\.id = ura\.entity_membership_id/);
  assert.match(sql, /ura\.station_id = v_station_id/);
  assert.match(sql, /ura\.team_id = v_team_id/);
  assert.match(sql, /ura\.profile_id <> p_submitter/);
  assert.match(sql, /p\.status = 'approved'/);
  assert.match(sql, /ura\.revoked_at is null/);
});

test("alerts are idempotent per report and DSE", () => {
  assert.match(sql, /'dse_report:' \|\| p_source_table \|\| ':' \|\| p_source_id::text \|\| ':' \|\| r\.profile_id::text/);
});

test("delivery failure never undoes the submission and is recorded for technical monitoring", () => {
  const trig = sql.slice(sql.indexOf("create or replace function public.notify_dse_of_report()"));
  assert.match(trig, /exception when others then/);
  assert.match(sql, /insert into public\.report_notification_failures/);
  assert.match(sql, /create or replace view public\.v_report_notification_health/);
  assert.match(sql, /canon_has_role\(array\['super_admin', 'operation_manager'\]\)/);
  assert.doesNotMatch(trig, /raise exception/, "the trigger itself never raises");
});

test("the bell titles the alert and links through the authorising report route", () => {
  assert.match(bell, /dse_report_submitted: "Report submitted by your team"/);
  assert.match(bell, /r\.event_type === "dse_report_submitted"/);
});
