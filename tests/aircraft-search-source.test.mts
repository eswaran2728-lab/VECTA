import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261203000004_aircraft_search_verification.sql", "utf8");
const actions = fs.readFileSync("lib/avsec/reports/actions.ts", "utf8");
const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} defined`);
  return sql.slice(start, sql.indexOf("$function$;", sql.indexOf("$function$", start) + 10) + 11);
};
const section = (from: string, to: string) => {
  const a = actions.indexOf(from);
  const b = actions.indexOf(to, a + from.length);
  return actions.slice(a, b < 0 ? undefined : b);
};

test("SEC029 submission no longer clears the Bay Board; it attaches evidence and the board shows submitted", () => {
  const sec029 = section("export async function submitSec029", "// ---------- ");
  assert.doesNotMatch(sec029, /cleared_at/);
  assert.doesNotMatch(sec029, /from\("bay_board"\)/);
  assert.match(sec029, /attach_search_to_sec029/);
  assert.match(fn("attach_search_to_sec029"), /search_state = 'submitted'/);
  assert.doesNotMatch(fn("attach_search_to_sec029"), /cleared_at\s*=/);
});

test("SEC016 departure never blocks on a late search but needs a reason, and clears the board only through the rules function", () => {
  const dep = section("export async function submitSec016", "// ---------- SEC 029");
  assert.match(dep, /preview_departure_search_secure/);
  assert.match(dep, /apply_departure_search_rules/);
  assert.match(dep, /search_late_reason/);
  assert.doesNotMatch(dep, /\.update\(\{\s*cleared_at/);
  assert.doesNotMatch(dep, /aircraft_search_completed\)/, "the officer's own checkbox is no longer the requirement test");
  assert.doesNotMatch(dep, /cabin_check[^\n]*search/i, "the cabin crew check is never read as a search");
});

test("the requirement uses exactly the three approved triggers and the 4 hour boundary", () => {
  const a = fn("aircraft_search_departure_assessment");
  assert.match(a, /interval '4 hours'/);
  assert.match(a, />= interval '4 hours'/);
  assert.match(a, /'ground_4h'/);
  assert.match(a, /'night_stop'/);
  assert.match(a, /'towed_from_hangar'/);
});

test("minimum durations, carrier thresholds and gap flags are the approved values", () => {
  assert.match(fn("aircraft_search_minimum_minutes"), /'A320' then 30 when 'A321' then 30 when 'A330' then 45/);
  assert.match(fn("aircraft_search_departure_assessment"), /= 'D7' then 90 else 45/);
  assert.match(fn("aircraft_search_departure_assessment"), /v_gap_std < v_threshold/);
  assert.match(fn("aircraft_search_departure_assessment"), /v_gap_dep < v_threshold/);
});

test("linking requires station, entity, flight AND registration", () => {
  const a = fn("aircraft_search_departure_assessment");
  assert.match(a, /r\.station = p_station and r\.entity = p_entity and upper\(r\.flight\)/);
  assert.match(a, /upper\(r\.registration\) = upper\(btrim\(p_registration\)\)/);
});

test("review is row-locked, single-decision, and refuses self, assistant, departure submitter, off-duty and ineligible reviewers", () => {
  const r = fn("review_aircraft_search_secure");
  assert.match(r, /for update/);
  for (const code of ["SELF_REVIEW", "ASSISTANT", "DEPARTURE_SUBMITTER", "OFF_DUTY", "NOT_ELIGIBLE", "WRONG_ENTITY", "ALREADY_DECIDED", "NOTE_REQUIRED", "NO_SEARCH"]) assert.match(r, new RegExp(code), code);
  assert.match(r, /rd\.code in \('so', 'sso', 'dse'\)/);
});

test("GPS is reported evidence: location or a reason is required, and unverified presence is recorded", () => {
  assert.match(fn("start_aircraft_search_secure"), /A reason is required when location is unavailable/);
  assert.match(fn("start_aircraft_search_secure"), /clock_timestamp\(\)/);
  assert.match(sql, /presence_status text not null default 'historical_unverified'/);
  const ui = fs.readFileSync("components/avsec/aircraft-search/SearchTimerPanel.tsx", "utf8");
  assert.match(ui, /not proof of presence/);
  assert.doesNotMatch(ui, /proof of physical presence is verified|verified presence/i);
});

test("every client-callable function is security definer, fixed search_path, revoked from anon", () => {
  for (const n of ["start_aircraft_search_secure", "finish_aircraft_search_secure", "attach_search_to_sec029", "review_aircraft_search_secure", "preview_departure_search_secure", "apply_departure_search_rules"]) {
    assert.match(fn(n), /security definer/i, n);
    assert.match(fn(n), /set search_path to 'public'/i, n);
    assert.ok(sql.includes(`revoke execute on function public.${n}(`), `${n} revoked`);
  }
  assert.doesNotMatch(sql, /delete from public\.aircraft_search_records/);
});
