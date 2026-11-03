import { haversineMeters, pointInPolygon, type GeoPolygon } from "./geofence";

/**
 * Rules for completing a shift handover in person. Pure (no framework imports) so every threshold is unit-tested. The DATABASE is the authority:
 * complete_handover_secure() applies the same rules inside one transaction; this mirror exists for tests and for explaining a failure to the user.
 *
 * What this evidence is and is not: a single-use QR shown on the outgoing officer's phone, plus two fresh browser locations that are accurate,
 * inside the station's duty zones and close to each other. It makes remote acknowledgment hard. It cannot prove a face-to-face meeting against
 * collusion or location spoofing, and must never be described as proof of physical presence.
 */
export const HANDOVER_CHALLENGE_TTL_SECONDS = 60;
export const HANDOVER_LOCATION_MAX_AGE_SECONDS = 30;
export const HANDOVER_MAX_ACCURACY_M = 50;
export const HANDOVER_MAX_SEPARATION_M = 50;
/** A location timestamp this far ahead of the server clock is treated as not fresh (phone clock skew allowance). */
export const HANDOVER_FUTURE_SKEW_SECONDS = 5;

export interface LocationFix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. */
  accuracyM: number;
  capturedAtMs: number;
}

export type HandoverVerificationCode =
  | "OK"
  | "CHALLENGE_EXPIRED"
  | "SENDER_LOCATION_STALE"
  | "RECIPIENT_LOCATION_STALE"
  | "ACCURACY"
  | "SENDER_OUTSIDE_ZONE"
  | "RECIPIENT_OUTSIDE_ZONE"
  | "TOO_FAR_APART";

export interface HandoverVerificationResult {
  ok: boolean;
  code: HandoverVerificationCode;
  distanceM: number;
}

const fresh = (f: LocationFix, nowMs: number) => {
  const age = (nowMs - f.capturedAtMs) / 1000;
  return Number.isFinite(age) && age <= HANDOVER_LOCATION_MAX_AGE_SECONDS && age >= -HANDOVER_FUTURE_SKEW_SECONDS;
};
const accurate = (f: LocationFix) => Number.isFinite(f.accuracyM) && f.accuracyM >= 0 && f.accuracyM <= HANDOVER_MAX_ACCURACY_M;
const inAnyZone = (f: LocationFix, zones: ReadonlyArray<{ polygon: GeoPolygon | null }>) => zones.some((z) => pointInPolygon(f.lng, f.lat, z.polygon));

/** Same order as the database function, so the first failing rule is the same everywhere. */
export function evaluateHandoverVerification(input: {
  nowMs: number;
  challengeIssuedAtMs: number;
  sender: LocationFix;
  recipient: LocationFix;
  zones: ReadonlyArray<{ polygon: GeoPolygon | null }>;
}): HandoverVerificationResult {
  const { nowMs, challengeIssuedAtMs, sender, recipient, zones } = input;
  const distanceM = haversineMeters(sender.lat, sender.lng, recipient.lat, recipient.lng);
  const fail = (code: HandoverVerificationCode): HandoverVerificationResult => ({ ok: false, code, distanceM });
  if (nowMs - challengeIssuedAtMs > HANDOVER_CHALLENGE_TTL_SECONDS * 1000) return fail("CHALLENGE_EXPIRED");
  if (!fresh(sender, nowMs)) return fail("SENDER_LOCATION_STALE");
  if (!fresh(recipient, nowMs)) return fail("RECIPIENT_LOCATION_STALE");
  if (!accurate(sender) || !accurate(recipient)) return fail("ACCURACY");
  if (!inAnyZone(sender, zones)) return fail("SENDER_OUTSIDE_ZONE");
  if (!inAnyZone(recipient, zones)) return fail("RECIPIENT_OUTSIDE_ZONE");
  if (!(distanceM <= HANDOVER_MAX_SEPARATION_M)) return fail("TOO_FAR_APART");
  return { ok: true, code: "OK", distanceM };
}

export const HANDOVER_FAILURE_MESSAGES: Record<Exclude<HandoverVerificationCode, "OK">, string> = {
  CHALLENGE_EXPIRED: "The QR code has expired. Ask the outgoing officer to show a new one.",
  SENDER_LOCATION_STALE: "The outgoing officer's location is not fresh. Ask them to keep the QR screen open with location on.",
  RECIPIENT_LOCATION_STALE: "Your location is not fresh. Keep location on and scan again.",
  ACCURACY: "A phone's location is not accurate enough (needs 50 metres or better). Move to open sky and try again.",
  SENDER_OUTSIDE_ZONE: "The outgoing officer is not inside a duty zone of this station.",
  RECIPIENT_OUTSIDE_ZONE: "You are not inside a duty zone of this station.",
  TOO_FAR_APART: "The two phones are more than 50 metres apart. Both officers must be together.",
};

export type HandoverStatus = "historical" | "pending" | "completed" | "uncompleted";

/** Malaysia (UTC+8, no DST) calendar date of an instant, as YYYY-MM-DD. */
export function malaysiaDate(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * A pending handover stops being completable (Uncompleted) once the outgoing officer has checked out, or once the duty date has ended: the
 * Malaysia date is more than one day after the sender's duty date (a night shift started on day D is still current on D+1). It remains an
 * audit record and never transfers responsibility. Completed and historical records never change status.
 */
export function effectiveHandoverStatus(
  h: { handover_status: string; created_at: string },
  sender: { senderCheckedOut: boolean; dutyDate: string | null },
  nowMs: number,
): HandoverStatus {
  if (h.handover_status === "completed") return "completed";
  if (h.handover_status !== "pending") return "historical";
  if (sender.senderCheckedOut) return "uncompleted";
  const duty = sender.dutyDate ?? malaysiaDate(Date.parse(h.created_at));
  const days = (Date.parse(malaysiaDate(nowMs)) - Date.parse(duty)) / 86_400_000;
  return days > 1 ? "uncompleted" : "pending";
}
