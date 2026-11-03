/**
 * Aircraft search verification rules. Pure, so every boundary is unit-tested; the DATABASE functions of migration 20261203000004 apply the same rules
 * and are the authority. All dates are Malaysia (UTC+8, no DST).
 *
 * A reported GPS location is evidence of where the device said it was. It is never proof that the officer was physically at the aircraft.
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MYT_OFFSET = 8 * HOUR;

/** Malaysia calendar day number of an instant. */
const mytDay = (ms: number) => Math.floor((ms + MYT_OFFSET) / DAY);

export type SearchReason = "ground_4h" | "night_stop" | "towed_from_hangar";

/** A search is required when the aircraft was on ground 4 h or more, had a night stop (on ground across 00:00 Malaysia time), or was towed from a hangar. */
export function searchRequirement(input: { onGroundSinceMs: number; departureMs: number; towedFromHangar: boolean }): { required: boolean; reasons: SearchReason[] } {
  const reasons: SearchReason[] = [];
  if (input.departureMs - input.onGroundSinceMs >= 4 * HOUR) reasons.push("ground_4h");
  if (mytDay(input.departureMs) > mytDay(input.onGroundSinceMs)) reasons.push("night_stop");
  if (input.towedFromHangar) reasons.push("towed_from_hangar");
  return { required: reasons.length > 0, reasons };
}

/** 30 minutes for A320/A321, 45 minutes for A330; null when no minimum is defined for the type. */
export function minimumSearchMinutes(aircraftType: string): number | null {
  const t = aircraftType.replace(/\s+/g, "").toUpperCase();
  if (t === "A320" || t === "A321") return 30;
  if (t === "A330") return 45;
  return null;
}

/** Duration from the SERVER start and finish times. A finish before the start is below any minimum. */
export function evaluateSearchDuration(startMs: number, finishMs: number, aircraftType: string): { minutes: number; belowMinimum: boolean; minimum: number | null } {
  const minimum = minimumSearchMinutes(aircraftType);
  const minutes = (finishMs - startMs) / MIN;
  const belowMinimum = finishMs < startMs ? true : minimum !== null && finishMs - startMs < minimum * MIN;
  return { minutes, belowMinimum, minimum };
}

export type Carrier = "AK" | "D7";

export function carrierThresholdMinutes(carrier: Carrier): 45 | 90 {
  return carrier === "AK" ? 45 : 90;
}

/** The STD is a time of day; its date is the Malaysia date that puts it nearest the reference instant (within 12 hours either side). */
export function stdInstantMs(stdHHmm: string, referenceMs: number): number {
  const [h, m] = stdHHmm.split(":").map((x) => Number.parseInt(x, 10));
  const refDay = mytDay(referenceMs);
  let best = Number.NaN;
  for (const d of [refDay - 1, refDay, refDay + 1]) {
    const candidate = d * DAY - MYT_OFFSET + (h * 60 + m) * MIN;
    if (Number.isNaN(best) || Math.abs(candidate - referenceMs) < Math.abs(best - referenceMs)) best = candidate;
  }
  return best;
}

export interface TurnaroundGaps {
  stdGapMinutes: number;
  departureGapMinutes: number;
  stdFlag: boolean;
  departureFlag: boolean;
  flagged: boolean;
}

/**
 * Both gaps run from SEC029 SUBMISSION: (1) to the staff-entered STD, (2) to SEC016 submission. Either gap under the carrier threshold (AK 45, D7 90 minutes) is
 * flagged. Filing the SEC016 late cannot repair a search that missed the STD threshold, because gap (1) does not depend on when the SEC016 is filed.
 */
export function evaluateTurnaroundGaps(input: { searchSubmittedMs: number; stdMs: number; departureSubmittedMs: number; carrier: Carrier }): TurnaroundGaps {
  const threshold = carrierThresholdMinutes(input.carrier);
  const stdGapMinutes = Math.round(((input.stdMs - input.searchSubmittedMs) / MIN) * 100) / 100;
  const departureGapMinutes = Math.round(((input.departureSubmittedMs - input.searchSubmittedMs) / MIN) * 100) / 100;
  const stdFlag = stdGapMinutes < threshold;
  const departureFlag = departureGapMinutes < threshold;
  return { stdGapMinutes, departureGapMinutes, stdFlag, departureFlag, flagged: stdFlag || departureFlag };
}

export interface SearchCandidate {
  id: string;
  station: string;
  entity: string;
  flight: string;
  registration: string;
  submittedMs: number;
  complete: boolean;
}

const norm = (s: string) => s.trim().toUpperCase();

/** Links a departure to its SEC029 by station, operating entity, flight AND registration. Another aircraft's or flight's report is never evidence. */
export function linkSearchToDeparture(
  departure: { station: string; entity: string; flight: string; registration: string },
  searches: readonly SearchCandidate[],
): { status: "linked"; searchId: string; duplicates: string[] } | { status: "missing" } {
  const matches = searches
    .filter((s) => s.complete && norm(s.station) === norm(departure.station) && norm(s.entity) === norm(departure.entity) && norm(s.flight) === norm(departure.flight) && norm(s.registration) === norm(departure.registration))
    .sort((a, b) => a.submittedMs - b.submittedMs);
  if (matches.length === 0) return { status: "missing" };
  return { status: "linked", searchId: matches[0].id, duplicates: matches.slice(1).map((m) => m.id) };
}

/** A usable fix is reported location evidence. With no fix, a reason of at least 5 characters is required and presence stays unverified. */
export function gpsEvidence(fix: { lat: number; lng: number; accuracyM: number } | null, reason: string | null): { presence: "reported" | "unverified"; ok: boolean; error?: string } {
  if (fix) {
    const valid = Number.isFinite(fix.lat) && Number.isFinite(fix.lng) && Number.isFinite(fix.accuracyM) && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180 && fix.accuracyM >= 0;
    return valid ? { presence: "reported", ok: true } : { presence: "unverified", ok: false, error: "The reported location is not valid." };
  }
  if ((reason ?? "").trim().length >= 5) return { presence: "unverified", ok: true };
  return { presence: "unverified", ok: false, error: "A reason is required when location is unavailable." };
}

/** A different, on-duty SO, SSO or DSE of the same station and entity; nobody who took part in the search or filed the departure may review it. */
export function mayReviewSearch(
  reviewer: { id: string; onDuty: boolean; role: string; station: string; entity: string },
  search: { submitterId: string; assistantId: string | null; departureSubmitterId: string | null; station: string; entity: string },
): { ok: boolean; reason?: string } {
  if (reviewer.id === search.submitterId) return { ok: false, reason: "You cannot review your own search." };
  if (reviewer.id === search.assistantId) return { ok: false, reason: "The assisting officer cannot review the search." };
  if (reviewer.id === search.departureSubmitterId) return { ok: false, reason: "The officer who filed the departure cannot review the search." };
  if (!["so", "sso", "dse"].includes(reviewer.role)) return { ok: false, reason: "Only an SO, SSO or DSE may review an aircraft search." };
  if (!reviewer.onDuty) return { ok: false, reason: "The reviewer must be on duty." };
  if (norm(reviewer.station) !== norm(search.station) || norm(reviewer.entity) !== norm(search.entity)) return { ok: false, reason: "The reviewer must be at the same station and operating entity." };
  return { ok: true };
}
