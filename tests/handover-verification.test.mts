import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOVER_CHALLENGE_TTL_SECONDS,
  HANDOVER_LOCATION_MAX_AGE_SECONDS,
  HANDOVER_MAX_ACCURACY_M,
  HANDOVER_MAX_SEPARATION_M,
  evaluateHandoverVerification,
  effectiveHandoverStatus,
  type LocationFix,
} from "../lib/avsec/duty/handover-verification.ts";
import { handoverSchema } from "../lib/avsec/schemas/handover.ts";

// A small square zone around (3.1000, 101.7000), about 220 m on a side.
const ZONE = { type: "Polygon" as const, coordinates: [[[101.699, 3.099], [101.701, 3.099], [101.701, 3.101], [101.699, 3.101], [101.699, 3.099]]] };
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);
const fix = (lat: number, lng: number, accuracyM = 10, ageSeconds = 5): LocationFix => ({ lat, lng, accuracyM, capturedAtMs: NOW - ageSeconds * 1000 });
// 1 degree of latitude is ~111,195 m, so 0.0004 deg ~ 44.5 m and 0.00045 deg ~ 50.04 m.
const A = fix(3.1, 101.7);
const run = (over: Partial<Parameters<typeof evaluateHandoverVerification>[0]> = {}) =>
  evaluateHandoverVerification({ nowMs: NOW, challengeIssuedAtMs: NOW - 20_000, sender: A, recipient: fix(3.1004, 101.7), zones: [{ polygon: ZONE }], ...over });

test("constants are the approved thresholds", () => {
  assert.equal(HANDOVER_CHALLENGE_TTL_SECONDS, 60);
  assert.equal(HANDOVER_LOCATION_MAX_AGE_SECONDS, 30);
  assert.equal(HANDOVER_MAX_ACCURACY_M, 50);
  assert.equal(HANDOVER_MAX_SEPARATION_M, 50);
});

test("two fresh, accurate positions inside a zone and within 50 m verify", () => {
  const r = run();
  assert.equal(r.ok, true);
  assert.equal(r.code, "OK");
  assert.ok(r.distanceM > 40 && r.distanceM < 50, String(r.distanceM));
});

test("challenge: valid at 60 s, expired after 60 s", () => {
  assert.equal(run({ challengeIssuedAtMs: NOW - 60_000 }).code, "OK");
  assert.equal(run({ challengeIssuedAtMs: NOW - 60_001 }).code, "CHALLENGE_EXPIRED");
});

test("location freshness: 30 s is accepted, 31 s is stale, for each phone separately; a future timestamp is rejected", () => {
  assert.equal(run({ sender: fix(3.1, 101.7, 10, 30) }).code, "OK");
  assert.equal(run({ sender: fix(3.1, 101.7, 10, 31) }).code, "SENDER_LOCATION_STALE");
  assert.equal(run({ recipient: fix(3.1004, 101.7, 10, 30) }).code, "OK");
  assert.equal(run({ recipient: fix(3.1004, 101.7, 10, 31) }).code, "RECIPIENT_LOCATION_STALE");
  assert.equal(run({ recipient: fix(3.1004, 101.7, 10, -10) }).code, "RECIPIENT_LOCATION_STALE", "10 s in the future is not fresh");
});

test("accuracy: 50 m is accepted, above 50 m is rejected, for either phone", () => {
  assert.equal(run({ sender: fix(3.1, 101.7, 50) }).code, "OK");
  assert.equal(run({ sender: fix(3.1, 101.7, 50.1) }).code, "ACCURACY");
  assert.equal(run({ recipient: fix(3.1004, 101.7, 50.1) }).code, "ACCURACY");
  assert.equal(run({ recipient: fix(3.1004, 101.7, Number.NaN) }).code, "ACCURACY", "a missing accuracy never passes");
});

test("zone containment: each phone must be inside an active zone of the station", () => {
  assert.equal(run({ sender: fix(3.2, 101.8) }).code, "SENDER_OUTSIDE_ZONE");
  assert.equal(run({ recipient: fix(3.2, 101.8) }).code, "RECIPIENT_OUTSIDE_ZONE");
  assert.equal(run({ zones: [] }).code, "SENDER_OUTSIDE_ZONE", "a station with no zone can never verify");
  assert.equal(run({ zones: [{ polygon: null }] }).code, "SENDER_OUTSIDE_ZONE");
});

test("separation: within 50 m verifies, beyond 50 m is rejected even when both are inside zones", () => {
  assert.equal(run({ recipient: fix(3.10044, 101.7) }).ok, true);
  const far = run({ recipient: fix(3.10046, 101.7) });
  assert.equal(far.code, "TOO_FAR_APART");
  assert.ok(far.distanceM > 50);
});

test("separation is measured between the two reported positions, not from a zone centre", () => {
  const s = fix(3.0999, 101.6991); // inside the zone near one corner
  const r = fix(3.1009, 101.7009); // inside the zone near the opposite corner
  assert.equal(run({ sender: s, recipient: r }).code, "TOO_FAR_APART");
});

test("effective status: completed and historical never change; a pending record is Uncompleted after sender checkout or when the duty date has ended", () => {
  const base = { created_at: "2026-11-03T02:00:00Z" };
  const day = (iso: string) => Date.parse(iso);
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "completed" }, { senderCheckedOut: true, dutyDate: "2026-11-03" }, day("2026-11-05T00:00:00Z")), "completed");
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "historical" }, { senderCheckedOut: false, dutyDate: null }, day("2026-12-05T00:00:00Z")), "historical");
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "pending" }, { senderCheckedOut: false, dutyDate: "2026-11-03" }, day("2026-11-03T05:00:00Z")), "pending");
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "pending" }, { senderCheckedOut: true, dutyDate: "2026-11-03" }, day("2026-11-03T05:00:00Z")), "uncompleted");
  // night shift: duty date 3 Nov is still current at 01:00 MYT on 4 Nov, but ended by 4 Nov midnight + a day (5 Nov MYT)
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "pending" }, { senderCheckedOut: false, dutyDate: "2026-11-03" }, day("2026-11-03T17:00:00Z")), "pending");
  assert.equal(effectiveHandoverStatus({ ...base, handover_status: "pending" }, { senderCheckedOut: false, dutyDate: "2026-11-03" }, day("2026-11-04T17:00:00Z")), "uncompleted");
});

test("handover input: the sender identity is never an input; the recipient is named by staff ID; notes are required", () => {
  const ok = handoverSchema.safeParse({ recipient_staff_id: " ab-123 ", place_category: "Bay", place_detail: "Bay 12", flight_number: "", handover_notes: "Hold bay 12" });
  assert.equal(ok.success, true);
  if (ok.success) assert.equal(ok.data.recipient_staff_id, "AB-123", "trimmed and upper-cased for the exact lookup");
  assert.equal(handoverSchema.safeParse({ place_category: "Bay", place_detail: "x", handover_notes: "n" }).success, false, "recipient required");
  assert.equal(handoverSchema.safeParse({ recipient_staff_id: "A1", place_category: "Bay", place_detail: "x", handover_notes: "" }).success, false);
  const parsed = handoverSchema.parse({ recipient_staff_id: "A1", place_category: "Bay", place_detail: "x", handover_notes: "n", staff_name: "Forged", staff_id: "FORGED", team: "ZZ" });
  assert.equal("staff_name" in parsed || "staff_id" in parsed || "team" in parsed, false, "client-supplied sender identity is dropped");
});
