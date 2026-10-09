/**
 * Flight number -> operating entity helper (AK -> MAA, D7 -> AAX). A pure mirror of the database classifier
 * (public.classify_flight_operating_entity): the form uses it only to SHOW the detected entity and to warn early. The database
 * re-derives and stores the classification from the trusted flight value on insert and never trusts this result; unknown, malformed,
 * conflicting (codeshare / several numbers) or missing values are NEVER guessed -- they stay unclassified and are queued for
 * controlled review. The prefix assists classification; it is not the only control (the stored classification is what reports use).
 */
export type FlightClassificationStatus = "classified" | "missing" | "malformed" | "unknown_prefix" | "conflict";

export interface FlightClassification {
  status: FlightClassificationStatus;
  prefix: string | null;
  entityCode: "MAA" | "AAX" | null;
  normalized: string | null;
}

export const FLIGHT_PREFIX_TO_ENTITY: Readonly<Record<string, "MAA" | "AAX">> = { AK: "MAA", D7: "AAX" };

export function normalizeFlightNumber(raw: string | null | undefined): string | null {
  const normalized = (raw ?? "").toUpperCase().replace(/[\s_./-]+/g, "");
  return normalized === "" ? null : normalized;
}

export function classifyFlightNumber(raw: string | null | undefined): FlightClassification {
  const trimmed = (raw ?? "").trim();
  const normalized = normalizeFlightNumber(raw);
  if (trimmed === "" || normalized === null) return { status: "missing", prefix: null, entityCode: null, normalized: null };
  // several flight numbers in one value (codeshare / combined entries) are never guessed
  const multi =
    /[/,;+&]/.test(trimmed) ||
    /\s+(or|and)\s+/i.test(trimmed) ||
    /[A-Z0-9]{2}[\s-]*[0-9]{1,4}[A-Z]?\s+[A-Z0-9]{2}[\s-]*[0-9]{1,4}/.test(trimmed.toUpperCase());
  if (multi) return { status: "conflict", prefix: null, entityCode: null, normalized };
  if (/^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/.test(normalized)) {
    const prefix = normalized.slice(0, 2);
    const entityCode = FLIGHT_PREFIX_TO_ENTITY[prefix] ?? null;
    return entityCode
      ? { status: "classified", prefix, entityCode, normalized }
      : { status: "unknown_prefix", prefix, entityCode: null, normalized };
  }
  return { status: "malformed", prefix: null, entityCode: null, normalized };
}

/** Human-readable explanation for the form (never a blocking error: an unclassified report is still submitted and reviewed). */
export function describeFlightClassification(c: FlightClassification): string {
  switch (c.status) {
    case "classified":
      return `Detected operating entity: ${c.entityCode} (prefix ${c.prefix})`;
    case "missing":
      return "Enter the flight number to detect the operating entity.";
    case "conflict":
      return "More than one flight number detected. The report will be sent for entity review instead of being assigned automatically.";
    case "unknown_prefix":
      return `Prefix ${c.prefix} is not a known operating-entity prefix. The report will be sent for entity review.`;
    default:
      return "This does not look like a flight number. The report will be sent for entity review.";
  }
}
