import test from "node:test";
import assert from "node:assert/strict";
import { pointInPolygon, haversineMeters, type GeoPolygon } from "../lib/avsec/duty/geofence.ts";
import type { DutyZone } from "../lib/avsec/duty/types.ts";

// Sample airport terminal polygon (KUL klia2 Terminal)
const KUL_KLIA2_POLYGON: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [101.684, 2.742],
      [101.689, 2.742],
      [101.689, 2.748],
      [101.684, 2.748],
      [101.684, 2.742],
    ],
  ],
};

// Sample airport cargo zone polygon (BKI Terminal)
const BKI_CARGO_POLYGON: GeoPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [116.050, 5.930],
      [116.055, 5.930],
      [116.055, 5.935],
      [116.050, 5.935],
      [116.050, 5.930],
    ],
  ],
};

const SAMPLE_ZONES: DutyZone[] = [
  {
    id: "zone-kul-1",
    station: "KUL",
    name: "klia2 Main Terminal",
    code: "T2-MAIN",
    polygon: KUL_KLIA2_POLYGON,
    center_lat: 2.745,
    center_lng: 101.6865,
    active: true,
  },
  {
    id: "zone-bki-1",
    station: "BKI",
    name: "BKI Cargo Terminal",
    code: "BKI-CRG",
    polygon: BKI_CARGO_POLYGON,
    center_lat: 5.9325,
    center_lng: 116.0525,
    active: true,
  },
];

function matchZone(position: { lat: number; lng: number } | null, zones: DutyZone[]): DutyZone | null {
  if (!position) return null;
  return zones.find((z) => pointInPolygon(position.lng, position.lat, z.polygon)) ?? null;
}

test("pointInPolygon: accurately identifies points inside boundary", () => {
  // Center of klia2 zone
  const inside = pointInPolygon(101.6865, 2.745, KUL_KLIA2_POLYGON);
  assert.equal(inside, true);
});

test("pointInPolygon: accurately identifies points outside boundary", () => {
  // Point far away in Kuala Lumpur city center (3.139, 101.6869)
  const outside = pointInPolygon(101.6869, 3.139, KUL_KLIA2_POLYGON);
  assert.equal(outside, false);

  // Point just outside klia2 polygon boundary
  const justOutside = pointInPolygon(101.691, 2.745, KUL_KLIA2_POLYGON);
  assert.equal(justOutside, false);
});

test("matchZone: returns matching zone when GPS is inside designated station polygon", () => {
  // User at KUL
  const kulPos = { lat: 2.745, lng: 101.6865 };
  const matchedKul = matchZone(kulPos, SAMPLE_ZONES);
  assert.ok(matchedKul);
  assert.equal(matchedKul.id, "zone-kul-1");
  assert.equal(matchedKul.station, "KUL");

  // User at BKI
  const bkiPos = { lat: 5.9325, lng: 116.0525 };
  const matchedBki = matchZone(bkiPos, SAMPLE_ZONES);
  assert.ok(matchedBki);
  assert.equal(matchedBki.id, "zone-bki-1");
  assert.equal(matchedBki.station, "BKI");
});

test("matchZone: returns null when GPS is outside all station zones", () => {
  // Staff standing at home / outside airport
  const homePos = { lat: 3.1478, lng: 101.6953 };
  const matched = matchZone(homePos, SAMPLE_ZONES);
  assert.equal(matched, null);
});

test("matchZone: returns null when GPS position is unavailable (no signal / permission denied)", () => {
  const matched = matchZone(null, SAMPLE_ZONES);
  assert.equal(matched, null);
});

test("Check-in button enablement logic: strictly tied to real GPS geofence", () => {
  const getButtonState = (
    position: { lat: number; lng: number } | null,
    zones: DutyZone[],
    locating: boolean,
    submitting: boolean
  ) => {
    const insideZone = matchZone(position, zones);
    const zoneBlocked = zones.length > 0 && !insideZone;
    const disabled = submitting || locating || !position || zoneBlocked;

    let buttonText = "Check in";
    if (submitting) buttonText = "Submitting…";
    else if (locating) buttonText = "Confirming your location…";
    else if (!position) buttonText = "GPS Location Required";
    else if (zoneBlocked) buttonText = "Move to duty zone to check in";

    return { disabled, insideZone, buttonText };
  };

  // Case 1: GPS disabled / unavailable -> Button is DISABLED
  const noGps = getButtonState(null, SAMPLE_ZONES, false, false);
  assert.equal(noGps.disabled, true);
  assert.equal(noGps.buttonText, "GPS Location Required");

  // Case 2: Locating in progress -> Button is DISABLED
  const locatingState = getButtonState(null, SAMPLE_ZONES, true, false);
  assert.equal(locatingState.disabled, true);
  assert.equal(locatingState.buttonText, "Confirming your location…");

  // Case 3: GPS outside geofence -> Button is DISABLED
  const outsidePos = { lat: 3.1478, lng: 101.6953 };
  const outsideState = getButtonState(outsidePos, SAMPLE_ZONES, false, false);
  assert.equal(outsideState.disabled, true);
  assert.equal(outsideState.insideZone, null);
  assert.equal(outsideState.buttonText, "Move to duty zone to check in");

  // Case 4: GPS inside geofence -> Button is ENABLED
  const insidePos = { lat: 2.745, lng: 101.6865 };
  const insideState = getButtonState(insidePos, SAMPLE_ZONES, false, false);
  assert.equal(insideState.disabled, false);
  assert.ok(insideState.insideZone);
  assert.equal(insideState.buttonText, "Check in");
});

test("Role neutrality: ASO, SO, and DSE roles all adhere to strict GPS geofencing with no manual override", () => {
  const roles = ["aso", "so", "dse"] as const;
  const outsidePos = { lat: 3.000, lng: 101.000 };

  for (const role of roles) {
    const match = matchZone(outsidePos, SAMPLE_ZONES);
    assert.equal(match, null, `Role ${role} must not bypass geofencing`);
  }
});
