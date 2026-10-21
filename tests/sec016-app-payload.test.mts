import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-expect-error plain .mjs tooling modules
import * as F from "../scripts/staging/lib/sec016-fixtures.mjs";

const src = fs.readFileSync("lib/avsec/reports/actions.ts", "utf8").replace(/\r\n/g, "\n");

/** Keys (top-level `name:` lines) of the object literal passed to the first call matching `anchor`, up to `end`. */
function keysBetween(anchor: string, end: string, from = 0, indent = 6): string[] {
  const a = src.indexOf(anchor, from);
  assert.ok(a >= 0, `anchor not found: ${anchor}`);
  const b = src.indexOf(end, a);
  assert.ok(b > a, `end not found after: ${anchor}`);
  return [...src.slice(a, b).matchAll(new RegExp(`^ {${indent}}([a-z_0-9]+):`, "gm"))].map((m) => m[1]);
}

test("the probe's SEC016 insert has exactly the keys the application sends (names and order), so the dry run tests the real statement", () => {
  const keys = keysBetween('.from("report_sec016")\n    .insert({', '})\n    .select("id, submitted_at, report_no")');
  assert.deepEqual(F.SEC016_APP_COLUMNS, keys);
  assert.equal(keys.length, 39);
});

test("the probe's Bay Board arrival insert, departure clear and manual entry match the application", () => {
  const arrival = keysBetween('supabase.from("bay_board").insert({', "});", src.indexOf("Bay Board auto-linkage"), 8);
  assert.deepEqual(F.BAY_ARRIVAL_COLUMNS, arrival);
  const depStart = src.indexOf('.from("bay_board")\n        .update({');
  const dep = [...src.slice(depStart, src.indexOf('})\n        .eq("station", v.station)', depStart)).matchAll(/^\s{10}([a-z_0-9]+):/gm)].map((m) => m[1]);
  assert.deepEqual(F.BAY_DEPARTURE_UPDATE_COLUMNS, dep);
  const manualStart = src.indexOf("export async function addBayBoardEntry");
  const manual = keysBetween('.from("bay_board")\n    .insert({', "})\n    .select", manualStart);
  assert.deepEqual(F.BAY_MANUAL_COLUMNS, manual);
});

test("every column the application writes is declared in the generated types for the table (no probe column is invented)", () => {
  const types = fs.readFileSync("lib/supabase/database.types.ts", "utf8").replace(/\r\n/g, "\n");
  const block = (table: string) => {
    const a = types.indexOf(`\n      ${table}: {\n        Row:`);
    assert.ok(a >= 0, table);
    return types.slice(a, types.indexOf("Relationships", a));
  };
  const sec = block("report_sec016");
  for (const c of F.SEC016_APP_COLUMNS) assert.match(sec, new RegExp(`\\b${c}\\??:`), `report_sec016.${c} is in the generated types`);
  const bay = block("bay_board");
  for (const c of [...F.BAY_ARRIVAL_COLUMNS, ...F.BAY_DEPARTURE_UPDATE_COLUMNS, ...F.BAY_MANUAL_COLUMNS]) assert.match(bay, new RegExp(`\\b${c}\\??:`), `bay_board.${c} is in the generated types`);
});

test("the sixteen legacy NOT NULL columns are exactly those relaxed by the canonical rev03 migration, and the application never sends eight of them", () => {
  const rev03 = fs.readFileSync("supabase/migrations/20260914000001_sec016_rev03_direction_fields.sql", "utf8");
  const relaxed = [...rev03.matchAll(/ALTER COLUMN (\w+) DROP NOT NULL/g)].map((m) => m[1]).sort();
  assert.deepEqual([...F.SEC016_LEGACY_NULLABLE].sort(), relaxed);
  assert.equal(relaxed.length, 16);
  const sent = new Set(F.SEC016_APP_COLUMNS);
  assert.deepEqual(F.SEC016_NEVER_SENT.filter((c) => sent.has(c)), []);
  assert.deepEqual(F.SEC016_LEGACY_NULLABLE.filter((c) => !sent.has(c)).sort(), [...F.SEC016_NEVER_SENT].sort());
});

test("columns the hosted database lacks are exactly the application's unmet needs: the new-column map covers every app key that is not on hosted", () => {
  // hosted report_sec016 columns frozen from the read-only observation (61): the app keys outside this set are the new columns
  const needed = F.SEC016_APP_COLUMNS.filter((c: string) => c in F.SEC016_NEW_COLUMNS).sort();
  assert.deepEqual(needed, Object.keys(F.SEC016_NEW_COLUMNS).sort(), "all eight new columns are written by the current SEC016 submission");
});

test("the payload builder emits the application's keys for both directions; omitted legacy fields are absent or null", () => {
  for (const flightType of ["arrival", "departure"]) {
    const p = F.sec016AppPayload({ profileId: "p", station: "S", team: "T", name: "N", staffNo: "1", reg: "R", flight: "F", flightType });
    assert.deepEqual(Object.keys(p), F.SEC016_APP_COLUMNS);
    assert.equal(p.ops_group, null);
    for (const c of F.SEC016_NEVER_SENT) assert.ok(!(c in p), `${c} is never sent`);
  }
  const arrival = F.sec016AppPayload({ profileId: "p", station: "S", team: "T", name: "N", staffNo: "1", reg: "R", flight: "F", flightType: "arrival" });
  assert.equal(arrival.outbound_baggage, null);
  assert.notEqual(arrival.inbound_baggage, null);
});
