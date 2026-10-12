import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  HUB_DESTINATIONS,
  HUB_DESTINATION_LABELS,
  isHubDestination,
} from "../lib/icms/constants.ts";
import { hubDestinationError } from "../lib/icms/canonical.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");

test("HUB_DESTINATIONS is the single list and includes KCH and BKI", () => {
  assert.deepEqual([...HUB_DESTINATIONS], ["PEN", "JHB", "NILAI", "KCH", "BKI"]);
});

test("every hub destination has a display label", () => {
  for (const d of HUB_DESTINATIONS) {
    assert.ok(HUB_DESTINATION_LABELS[d], `label for ${d}`);
  }
  assert.match(HUB_DESTINATION_LABELS.KCH, /Kuching/);
  assert.match(HUB_DESTINATION_LABELS.BKI, /Kota Kinabalu/);
});

test("isHubDestination accepts the five stations and rejects everything else", () => {
  for (const d of ["PEN", "JHB", "NILAI", "KCH", "BKI"]) assert.equal(isHubDestination(d), true, d);
  for (const d of ["KUL", "BTU", "pen", "", null, undefined]) assert.equal(isHubDestination(d), false, String(d));
});

test("Part Hub scan/step rule: only the destination station may proceed, including KCH and BKI", () => {
  const args = { nextStepPart: "part_hub", route: "HUB" };
  assert.equal(hubDestinationError({ ...args, hubDestination: "KCH", userStation: "KCH" }), null);
  assert.equal(hubDestinationError({ ...args, hubDestination: "BKI", userStation: "BKI" }), null);
  assert.match(hubDestinationError({ ...args, hubDestination: "KCH", userStation: "BKI" }) ?? "", /KCH/);
  assert.match(hubDestinationError({ ...args, hubDestination: "BKI", userStation: "PEN" }) ?? "", /BKI/);
});

test("no app code keeps its own hardcoded PEN/JHB/NILAI list", () => {
  const files = [
    "app/(icms)/icms/transactions/new/part-a-form.tsx",
    "app/(icms)/icms/transactions/[id]/part-hub/page.tsx",
    "lib/icms/actions/transactions.ts",
    "lib/icms/actions/scan.ts",
  ];
  for (const f of files) {
    const src = read(f);
    assert.ok(!/\[\s*["']PEN["']\s*,\s*["']JHB["']\s*,\s*["']NILAI["']\s*\]/.test(src), `${f} must use HUB_DESTINATIONS`);
  }
});

test("HubDestination type is derived from the list, not retyped", () => {
  const src = read("lib/icms/database.types.ts");
  assert.ok(!/HubDestination\s*=\s*"PEN"\s*\|\s*"JHB"\s*\|\s*"NILAI"\s*;/.test(src), "type must include KCH and BKI");
  assert.match(src, /HubDestination[\s\S]*\bKCH\b[\s\S]*\bBKI\b/);
});

test("migration: both CHECK constraints allow KCH and BKI, additively and idempotently", () => {
  const dir = path.join(REPO, "supabase/migrations");
  const name = fs.readdirSync(dir).find((f) => /hub_destinations_kch_bki\.sql$/.test(f));
  assert.ok(name, "a hub_destinations_kch_bki migration exists");
  const sql = strip(read(`supabase/migrations/${name}`));
  assert.match(sql, /drop constraint if exists transactions_hub_destination_check/);
  assert.match(sql, /drop constraint if exists part_hub_confirmed_destination_check/);
  assert.match(sql, /hub_destination in \('PEN', 'JHB', 'NILAI', 'KCH', 'BKI'\) or hub_destination is null/);
  assert.match(sql, /confirmed_destination in \('PEN', 'JHB', 'NILAI', 'KCH', 'BKI'\)/);
  assert.ok(!/can_scan\s*=\s*true/.test(sql), "scanning is never enabled at KCH/BKI");
  assert.ok(!/drop table|delete from|truncate/i.test(sql), "no destructive statements");
  assert.ok(!/create or replace function/.test(sql), "no function is replaced");
});
