import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stepsFor } from "../lib/icms/workflow.ts";
import { KNOWN_BLOCKERS, ROUTE_READINESS, movementCompletable, WRITE_PATH_PARTS, RECEIPT_SERVED_PARTS } from "../lib/icms/route-readiness.ts";

/**
 * Known functional blocker (a readiness check, not a defect to hide): Part C has no write path, so AIRCRAFT, REDQ, INBOUND and
 * MAINTENANCE movements cannot reach their final state. Only the HUB route (Part B, then the destination receipt) can complete.
 * These tests derive that from the state machine and from the code that actually writes statuses; when Part C is implemented they fail
 * until ROUTE_READINESS and the owner questions are updated on purpose.
 */
test("readiness is derived from the state machine: only the HUB route can complete today", () => {
  const expected: Record<string, boolean> = {
    "OUTBOUND/AIRCRAFT": false, "OUTBOUND/REDQ": false, "OUTBOUND/MAINTENANCE": false, "INBOUND/AIRCRAFT": false, "OUTBOUND/HUB": true,
  };
  for (const [key, want] of Object.entries(expected)) {
    const [direction, route] = key.split("/");
    assert.equal(movementCompletable(direction as never, route as never), want, key);
  }
  assert.deepEqual(ROUTE_READINESS.filter((r) => r.completable).map((r) => `${r.direction}/${r.route}`), ["OUTBOUND/HUB"]);
  for (const r of ROUTE_READINESS.filter((x) => !x.completable)) {
    assert.match(r.blocker ?? "", /Part (C|REDQ)/);
    assert.ok(stepsFor(r.direction, r.route).some((s) => !WRITE_PATH_PARTS.includes(s.part) && !RECEIPT_SERVED_PARTS.includes(s.part)), `${r.direction}/${r.route} has a step with no write path`);
  }
});

test("the blocker is recorded with its owner-question document", () => {
  assert.equal(KNOWN_BLOCKERS.length, 1);
  assert.equal(KNOWN_BLOCKERS[0].id, "PART_C_NO_WRITE_PATH");
  assert.ok(fs.existsSync(KNOWN_BLOCKERS[0].ownerQuestions), "the owner question list exists");
  const doc = fs.readFileSync(KNOWN_BLOCKERS[0].ownerQuestions, "utf8");
  for (const topic of ["actor", "station", "fields", "signature", "failure", "escalation", "transition", "notification"]) assert.match(doc, new RegExp(topic, "i"), topic);
});

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|sql)$/.test(e.name) ? [p] : [];
  });

test("static guard: nothing in the application or the migrations writes AIRPORT_POST_APPROVED, REDQ_RESEALED or POST6_APPROVED", () => {
  const files = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("supabase/migrations")].filter((f) => !f.endsWith("database.types.ts") && !f.endsWith("workflow.ts") && !f.split(path.sep).join("/").includes("supabase/migrations/icms/")); // the legacy ICMS migrations write tables that do not exist on the canonical model
  const writers: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8").replace(/--.*$/gm, "").replace(/\/\/.*$/gm, "");
    // an UPDATE .. SET status = '<state>' or an insert/update object assigning the state
    if (/set\s+status\s*=\s*'(AIRPORT_POST_APPROVED|REDQ_RESEALED|POST6_APPROVED)'/i.test(src) || /status\s*:\s*["'](AIRPORT_POST_APPROVED|REDQ_RESEALED|POST6_APPROVED)["']/.test(src)) writers.push(f);
  }
  assert.deepEqual(writers, [], "a new writer of a Part C / REDQ state exists: update ROUTE_READINESS, the receipt rules and the owner questions deliberately");
});

test("the movement-creation form and action refuse a route that cannot complete", () => {
  const form = fs.readFileSync("app/(icms)/icms/transactions/new/part-a-form.tsx", "utf8");
  assert.match(form, /movementCompletable/);
  assert.match(form, /aria-disabled/);
  const action = fs.readFileSync("lib/icms/actions/transactions.ts", "utf8");
  const create = action.slice(action.indexOf("export async function createTransaction("), action.indexOf("export async function completePartB("));
  assert.match(create, /movementCompletable\(/);
});

test("the database refuses a Driver-created movement on any route that cannot complete, and the guard matches the readiness matrix", () => {
  const sql = fs.readFileSync("supabase/migrations/20261112000001_block_unusable_driver_routes.sql", "utf8").replace(/--.*$/gm, "");
  assert.match(sql, /caterlink_external_role\(\) = 'warehouse_pic'/);
  assert.match(sql, /new\.direction = 'OUTBOUND'\s+and new\.route = 'HUB'/);
  assert.match(sql, /s\.id = new\.destination_station_id and s\.code = new\.hub_destination and s\.is_active/, "a HUB movement must name a hub and any destination station must be that active station");
  assert.match(sql, /raise exception 'This movement type is not available yet\.'/);
  assert.match(sql, /before insert on public\.transactions/);
  const completable = ROUTE_READINESS.filter((r) => r.completable).map((r) => `${r.direction}/${r.route}`);
  assert.deepEqual(completable, ["OUTBOUND/HUB"], "the SQL guard allows exactly the routes the readiness matrix says can complete");
});

test("documentation states that CaterLink is not complete beyond the HUB route", () => {
  const doc = fs.readFileSync("docs/dashboard-review/caterlink-workflow-gap-audit.md", "utf8");
  assert.match(doc, /not complete beyond (the )?HUB/i);
  assert.match(fs.readFileSync("docs/dashboard-review/part-c-owner-questions.md", "utf8"), /Outbound HUB[^\n]*\*\*Yes\*\*/);
});
