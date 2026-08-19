"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { haversineMeters } from "@/lib/avsec/duty/geofence";
import type { GeoPolygon } from "@/lib/avsec/duty/geofence";

const KL_FALLBACK: [number, number] = [3.139, 101.6869];

export interface ZoneGeometry {
  polygon: GeoPolygon | null;
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
}

function computeGeometry(points: [number, number][]): ZoneGeometry {
  if (points.length < 3) return { polygon: null, center_lat: null, center_lng: null, radius_m: null };

  const centerLat = points.reduce((s, [lat]) => s + lat, 0) / points.length;
  const centerLng = points.reduce((s, [, lng]) => s + lng, 0) / points.length;
  const radius = Math.round(Math.max(...points.map(([lat, lng]) => haversineMeters(centerLat, centerLng, lat, lng))));

  const ring = [...points, points[0]!].map(([lat, lng]) => [lng, lat]);
  return {
    polygon: { type: "Polygon", coordinates: [ring] },
    center_lat: centerLat,
    center_lng: centerLng,
    radius_m: radius,
  };
}

/** Click-to-add-vertex polygon drawing on plain Leaflet (no drawing plugin dependency) —
 * writes the resulting {polygon, center, radius} into a hidden form field as JSON so the
 * surrounding server-action form submits it like any other field. */
export default function ZoneMapEditor({
  initialPolygon,
  hiddenInputId,
}: {
  initialPolygon: GeoPolygon | null;
  hiddenInputId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.Layer[]>([]);
  const [points, setPoints] = useState<[number, number][]>(
    () => initialPolygon?.coordinates?.[0]?.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]) ?? [],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] = points[0] ?? KL_FALLBACK;
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: false }).setView(center, 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      setPoints((prev) => [...prev, [e.latlng.lat, e.latlng.lng]]);
    });
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layerRef.current.forEach((l) => l.remove());
    layerRef.current = [];

    points.forEach(([lat, lng], i) => {
      const marker = L.circleMarker([lat, lng], { radius: 6, color: "#FFD900", fillColor: "#FFD900", fillOpacity: 1 })
        .addTo(map)
        .bindTooltip(String(i + 1), { permanent: true, direction: "top", offset: [0, -6] });
      layerRef.current.push(marker);
    });

    if (points.length >= 2) {
      const closed = points.length >= 3 ? [...points, points[0]!] : points;
      const line = L.polygon(closed, { color: "#FFD900", weight: 2, fillOpacity: 0.08 }).addTo(map);
      layerRef.current.push(line);
    }

    const input = document.getElementById(hiddenInputId) as HTMLInputElement | null;
    if (input) input.value = JSON.stringify(computeGeometry(points));
  }, [points, hiddenInputId]);

  const geometry = computeGeometry(points);

  return (
    <div className="space-y-2">
      <div className="card overflow-hidden">
        <div ref={containerRef} style={{ width: "100%", height: "280px" }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
          {points.length < 3
            ? `Tap the map to add points (${points.length}/3 minimum)`
            : `${points.length} points · radius ≈${geometry.radius_m}m`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setPoints((prev) => prev.slice(0, -1))}
            disabled={points.length === 0}
          >
            Undo
          </button>
          <button type="button" className="btn-quiet" onClick={() => setPoints([])} disabled={points.length === 0}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
