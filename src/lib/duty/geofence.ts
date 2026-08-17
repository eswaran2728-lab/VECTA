// GeoJSON Polygon geometry as stored in duty_zones.polygon — coordinates are [lng, lat]
// pairs per the GeoJSON spec, first ring only (no holes supported).
export interface GeoPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

/** Ray-casting point-in-polygon test. Used identically on the client (instant UI feedback)
 * and the server (authoritative re-check before writing a duty record) — the client's
 * verdict is never trusted alone. */
export function pointInPolygon(lng: number, lat: number, polygon: GeoPolygon | null | undefined): boolean {
  const ring = polygon?.coordinates?.[0];
  if (!ring || ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi = 0, yi = 0] = ring[i]!;
    const [xj = 0, yj = 0] = ring[j]!;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
