import { test } from "node:test";
import assert from "node:assert/strict";
import {
  searchRequirement,
  minimumSearchMinutes,
  evaluateSearchDuration,
  carrierThresholdMinutes,
  stdInstantMs,
  evaluateTurnaroundGaps,
  linkSearchToDeparture,
  gpsEvidence,
  mayReviewSearch,
  type SearchCandidate,
} from "../lib/avsec/aircraft-search/rules.ts";

const MYT = (iso: string) => Date.parse(`${iso}+08:00`);

test("on ground exactly four hours requires a search; one second less does not", () => {
  const dep = MYT("2026-11-03T14:00:00");
  assert.deepEqual(searchRequirement({ onGroundSinceMs: dep - 14_400_000, departureMs: dep, towedFromHangar: false }), { required: true, reasons: ["ground_4h"] });
  assert.deepEqual(searchRequirement({ onGroundSinceMs: dep - 14_399_000, departureMs: dep, towedFromHangar: false }), { required: false, reasons: [] });
});

test("a night stop (on ground across 00:00 Malaysia time) requires a search even when under four hours", () => {
  const r = searchRequirement({ onGroundSinceMs: MYT("2026-11-03T23:50:00"), departureMs: MYT("2026-11-04T00:20:00"), towedFromHangar: false });
  assert.deepEqual(r, { required: true, reasons: ["night_stop"] });
  assert.equal(searchRequirement({ onGroundSinceMs: MYT("2026-11-04T00:05:00"), departureMs: MYT("2026-11-04T01:00:00"), towedFromHangar: false }).required, false, "wholly after midnight is not a night stop");
});

test("towed from a hangar requires a search on its own, and reasons accumulate", () => {
  const dep = MYT("2026-11-03T10:00:00");
  assert.deepEqual(searchRequirement({ onGroundSinceMs: dep - 3_600_000, departureMs: dep, towedFromHangar: true }), { required: true, reasons: ["towed_from_hangar"] });
  const all = searchRequirement({ onGroundSinceMs: MYT("2026-11-03T02:00:00"), departureMs: MYT("2026-11-04T09:00:00"), towedFromHangar: true });
  assert.deepEqual(all.reasons, ["ground_4h", "night_stop", "towed_from_hangar"]);
});

test("minimum search duration: 30 minutes for A320/A321, 45 minutes for A330, none for other types", () => {
  assert.equal(minimumSearchMinutes("A320"), 30);
  assert.equal(minimumSearchMinutes("A 321"), 30);
  assert.equal(minimumSearchMinutes("A330"), 45);
  assert.equal(minimumSearchMinutes("A 330"), 45);
  assert.equal(minimumSearchMinutes("Others"), null);
  const t0 = MYT("2026-11-03T08:00:00");
  assert.equal(evaluateSearchDuration(t0, t0 + 30 * 60_000, "A320").belowMinimum, false);
  assert.equal(evaluateSearchDuration(t0, t0 + 30 * 60_000 - 1000, "A320").belowMinimum, true);
  assert.equal(evaluateSearchDuration(t0, t0 + 45 * 60_000, "A330").belowMinimum, false);
  assert.equal(evaluateSearchDuration(t0, t0 + 44 * 60_000 + 59_000, "A330").belowMinimum, true);
  assert.equal(evaluateSearchDuration(t0, t0 + 5 * 60_000, "Others").belowMinimum, false, "no minimum known: never flagged on duration");
  assert.equal(evaluateSearchDuration(t0, t0 - 1000, "A320").belowMinimum, true, "finish before start is below minimum");
});

test("carrier thresholds: AK 45 minutes, D7 90 minutes", () => {
  assert.equal(carrierThresholdMinutes("AK"), 45);
  assert.equal(carrierThresholdMinutes("D7"), 90);
});

test("the STD time of day takes the Malaysia date nearest the reference, so midnight is handled", () => {
  assert.equal(stdInstantMs("00:30", MYT("2026-11-03T23:55:00")), MYT("2026-11-04T00:30:00"));
  assert.equal(stdInstantMs("23:50", MYT("2026-11-04T00:10:00")), MYT("2026-11-03T23:50:00"));
  assert.equal(stdInstantMs("14:00", MYT("2026-11-03T13:00:00")), MYT("2026-11-03T14:00:00"));
});

test("both gaps are measured from SEC029 submission, flagged independently, AK 45 / D7 90", () => {
  const search = MYT("2026-11-03T12:00:00");
  const ak = (stdMin: number, depMin: number) => evaluateTurnaroundGaps({ searchSubmittedMs: search, stdMs: search + stdMin * 60_000, departureSubmittedMs: search + depMin * 60_000, carrier: "AK" });
  assert.deepEqual(ak(45, 45), { stdGapMinutes: 45, departureGapMinutes: 45, stdFlag: false, departureFlag: false, flagged: false });
  assert.equal(ak(44, 60).stdFlag, true);
  assert.equal(ak(60, 44).departureFlag, true);
  assert.equal(ak(44, 60).departureFlag, false, "the two flags are independent");
  const d7 = (m: number) => evaluateTurnaroundGaps({ searchSubmittedMs: search, stdMs: search + m * 60_000, departureSubmittedMs: search + m * 60_000, carrier: "D7" });
  assert.equal(d7(90).flagged, false);
  assert.equal(d7(89).flagged, true);
  assert.equal(ak(-5, 60).stdFlag, true, "a search submitted after the STD is late");
});

test("delaying the SEC016 never hides a search that missed the STD threshold", () => {
  const search = MYT("2026-11-03T12:00:00");
  const r = evaluateTurnaroundGaps({ searchSubmittedMs: search, stdMs: search + 30 * 60_000, departureSubmittedMs: search + 600 * 60_000, carrier: "AK" });
  assert.equal(r.departureFlag, false);
  assert.equal(r.stdFlag, true);
  assert.equal(r.flagged, true);
});

const dep = { station: "KUL - MAA", entity: "MAA", flight: "AK123", registration: "9M-AAA" };
const cand = (over: Partial<SearchCandidate> = {}): SearchCandidate => ({ id: "s1", station: "KUL - MAA", entity: "MAA", flight: "ak123", registration: "9m-aaa", submittedMs: 1000, complete: true, ...over });

test("a SEC029 links only by station, entity, flight and registration; another aircraft or flight is never evidence", () => {
  assert.deepEqual(linkSearchToDeparture(dep, [cand()]), { status: "linked", searchId: "s1", duplicates: [] });
  for (const bad of [{ registration: "9M-BBB" }, { flight: "AK124" }, { station: "PEN" }, { entity: "AAX" }, { complete: false }]) {
    assert.deepEqual(linkSearchToDeparture(dep, [cand(bad)]), { status: "missing" }, JSON.stringify(bad));
  }
  assert.deepEqual(linkSearchToDeparture(dep, []), { status: "missing" });
});

test("duplicate matching SEC029: the earliest is used and the others are listed for the reviewer", () => {
  const r = linkSearchToDeparture(dep, [cand({ id: "late", submittedMs: 5000 }), cand({ id: "early", submittedMs: 1000 }), cand({ id: "mid", submittedMs: 3000 })]);
  assert.deepEqual(r, { status: "linked", searchId: "early", duplicates: ["mid", "late"] });
});

test("GPS: a fix is reported location evidence; no fix needs a reason and is unverified", () => {
  assert.deepEqual(gpsEvidence({ lat: 3.1, lng: 101.7, accuracyM: 12 }, null), { presence: "reported", ok: true });
  assert.equal(gpsEvidence(null, null).ok, false);
  assert.equal(gpsEvidence(null, "gps").ok, false, "a reason shorter than 5 characters is not a reason");
  assert.deepEqual(gpsEvidence(null, "Phone GPS switched off at bay"), { presence: "unverified", ok: true });
  assert.equal(gpsEvidence({ lat: 95, lng: 0, accuracyM: 5 }, null).ok, false, "an impossible coordinate is not a fix");
  assert.equal(gpsEvidence({ lat: 3.1, lng: 101.7, accuracyM: Number.NaN }, null).ok, false);
});

test("review: a different on-duty SO, SSO or DSE of the same station and entity; nobody involved in the search", () => {
  const search = { submitterId: "a", assistantId: "b", departureSubmitterId: "c", station: "KUL - MAA", entity: "MAA" };
  const rev = (over = {}) => ({ id: "r", onDuty: true, role: "so", station: "KUL - MAA", entity: "MAA", ...over });
  for (const role of ["so", "sso", "dse"]) assert.equal(mayReviewSearch(rev({ role }), search).ok, true, role);
  assert.equal(mayReviewSearch(rev({ id: "a" }), search).ok, false, "self-review");
  assert.equal(mayReviewSearch(rev({ id: "b" }), search).ok, false, "assisting officer");
  assert.equal(mayReviewSearch(rev({ id: "c" }), search).ok, false, "SEC016 submitter");
  assert.equal(mayReviewSearch(rev({ onDuty: false }), search).ok, false);
  assert.equal(mayReviewSearch(rev({ role: "aso" }), search).ok, false);
  assert.equal(mayReviewSearch(rev({ station: "PEN" }), search).ok, false);
  assert.equal(mayReviewSearch(rev({ entity: "AAX" }), search).ok, false);
});
