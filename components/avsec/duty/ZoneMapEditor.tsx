"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { haversineMeters } from "@/lib/avsec/duty/geofence";
import type { GeoPolygon } from "@/lib/avsec/duty/geofence";
import type { DutyZone } from "@/lib/avsec/duty/types";

// Airport and station coordinates for all AirAsia & Malaysian operational hubs
export const STATION_AIRPORT_COORDS: Record<string, [number, number]> = {
  "KUL - MAA": [2.7433, 101.6981], // KLIA / klia2 (AirAsia RedQ & Terminal 2)
  "KUL - AAX": [2.7433, 101.6981], // KLIA Terminal 1 & 2
  KUL: [2.7433, 101.6981],
  AOR: [6.1897, 100.3986], // Sultan Abdul Halim Airport (Alor Setar)
  BKI: [5.9372, 116.0513], // Kota Kinabalu International Airport
  BTU: [3.1239, 113.0204], // Bintulu Airport
  JHB: [1.6413, 103.6696], // Senai International Airport (Johor Bahru)
  KBR: [6.1664, 102.2934], // Sultan Ismail Petra Airport (Kota Bharu)
  KCH: [1.4847, 110.347], // Kuching International Airport
  LBU: [5.3007, 115.25], // Labuan Airport
  LGK: [6.3297, 99.7287], // Langkawi International Airport
  MYY: [4.322, 113.987], // Miri Airport
  PEN: [5.2971, 100.2769], // Penang International Airport
  SBW: [2.2611, 111.985], // Sibu Airport
  SDK: [5.9009, 118.0594], // Sandakan Airport
  TGG: [5.3826, 103.103], // Sultan Mahmud Airport (Kuala Terengganu)
  TWU: [4.3202, 118.1214], // Tawau Airport
  KUA: [3.7752, 103.2094], // Sultan Haji Ahmad Shah Airport (Kuantan)
  IPH: [4.568, 101.0924], // Sultan Azlan Shah Airport (Ipoh)
  MKZ: [2.2632, 102.2519], // Melaka International Airport
  SZB: [3.1306, 101.5492], // Sultan Abdul Aziz Shah Airport (Subang)
};

const DEFAULT_AIRPORT: [number, number] = [2.7433, 101.6981]; // KLIA klia2

export interface ZoneGeometry {
  polygon: GeoPolygon | null;
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
}

export function computeGeometry(points: [number, number][]): ZoneGeometry {
  if (points.length < 3) return { polygon: null, center_lat: null, center_lng: null, radius_m: null };

  const rawCenterLat = points.reduce((s, [lat]) => s + lat, 0) / points.length;
  const rawCenterLng = points.reduce((s, [, lng]) => s + lng, 0) / points.length;
  const centerLat = Number(rawCenterLat.toFixed(6));
  const centerLng = Number(rawCenterLng.toFixed(6));
  const radius = Math.round(Math.max(...points.map(([lat, lng]) => haversineMeters(centerLat, centerLng, lat, lng))));

  // GeoJSON coordinate order is [longitude, latitude], closed polygon ring
  const ring = [...points, points[0]!].map(([lat, lng]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  return {
    polygon: { type: "Polygon", coordinates: [ring] },
    center_lat: centerLat,
    center_lng: centerLng,
    radius_m: radius,
  };
}

export interface ZoneMapEditorProps {
  initialPolygon: GeoPolygon | null;
  hiddenInputId: string;
  station?: string;
  existingZones?: DutyZone[];
}

/** Interactive click-to-draw polygon map for Admin/DSE Zone Creation & Editing.
 * Displays real OpenStreetMap tiles centered on the selected airport, allows tapping/clicking
 * to add polygon boundary vertices, shows existing reference zones, and writes
 * valid GeoJSON geometry into a hidden form field for server submission.
 */
export default function ZoneMapEditor({
  initialPolygon,
  hiddenInputId,
  station,
  existingZones = [],
}: ZoneMapEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const activeLayersRef = useRef<L.Layer[]>([]);
  const backgroundLayersRef = useRef<L.Polygon[]>([]);

  // Parse initial points from GeoPolygon (GeoJSON [lng, lat] -> Leaflet [lat, lng])
  const [points, setPoints] = useState<[number, number][]>(() => {
    const ring = initialPolygon?.coordinates?.[0];
    if (!ring || ring.length < 3) return [];
    // If closed ring, strip the closing duplicate point for editor state
    const isClosed =
      ring.length > 3 &&
      ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1];
    const openRing = isClosed ? ring.slice(0, -1) : ring;
    return openRing.map(([lng, lat]) => [lat, lng] as [number, number]);
  });

  const getStationAirport = useCallback(() => {
    if (!station) return DEFAULT_AIRPORT;
    return STATION_AIRPORT_COORDS[station] || DEFAULT_AIRPORT;
  }, [station]);

  // Recenter / Fit View
  const handleResetOrFit = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (points.length >= 2) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds.pad(0.25), { maxZoom: 18, animate: true });
    } else if (existingZones.length > 0) {
      const zoneCoords: [number, number][] = [];
      for (const z of existingZones) {
        const ring = z.polygon?.coordinates?.[0];
        if (ring) {
          ring.forEach(([lng, lat]) => zoneCoords.push([lat, lng]));
        } else if (z.center_lat && z.center_lng) {
          zoneCoords.push([z.center_lat, z.center_lng]);
        }
      }
      if (zoneCoords.length > 0) {
        map.fitBounds(L.latLngBounds(zoneCoords).pad(0.2), { maxZoom: 18, animate: true });
        return;
      }
      map.setView(getStationAirport(), 16, { animate: true });
    } else {
      map.setView(getStationAirport(), 16, { animate: true });
    }
  }, [points, existingZones, getStationAirport]);

  // Initialize Map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const stationAirport = getStationAirport();
    const initialCenter: [number, number] = points[0] ?? stationAirport;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView(initialCenter, 16);

    // High quality standard OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      subdomains: ["a", "b", "c"],
    }).addTo(map);

    // Crosshair cursor indicates drawing area
    map.getContainer().style.cursor = "crosshair";

    // Click/tap to add vertex
    map.on("click", (e: L.LeafletMouseEvent) => {
      setPoints((prev) => [...prev, [e.latlng.lat, e.latlng.lng]]);
    });

    mapRef.current = map;

    // Trigger size invalidation to resolve any Next.js hydration / dynamic layout rendering
    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 300);
    const t3 = setTimeout(() => {
      map.invalidateSize();
      if (points.length >= 2) {
        map.fitBounds(L.latLngBounds(points).pad(0.3));
      }
    }, 500);

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Station changed -> pan to new airport if no custom points drawn
  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length > 0) return;
    map.setView(getStationAirport(), 16, { animate: true });
  }, [station, points.length, getStationAirport]);

  // Render existing reference zones as subtle background polygons
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    backgroundLayersRef.current.forEach((l) => l.remove());
    backgroundLayersRef.current = [];

    existingZones.forEach((zone) => {
      const ring = zone.polygon?.coordinates?.[0];
      if (!ring || ring.length < 3) return;

      const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
      const poly = L.polygon(latlngs, {
        color: "#12cbf5",
        weight: 1.5,
        fillColor: "#12cbf5",
        fillOpacity: 0.08,
        dashArray: "4, 4",
      }).addTo(map);

      poly.bindTooltip(
        `<div style="font-family: monospace; font-size: 10px; font-weight: 600;">
          ${zone.name} <span style="opacity: 0.7;">(${zone.code})</span>
        </div>`,
        { permanent: false, sticky: true }
      );

      backgroundLayersRef.current.push(poly);
    });
  }, [existingZones]);

  // Render actively drawn polygon vertices & lines
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    activeLayersRef.current.forEach((l) => l.remove());
    activeLayersRef.current = [];

    // Render numbered vertex markers with high-contrast amber badges
    points.forEach(([lat, lng], i) => {
      const icon = L.divIcon({
        className: "custom-vertex-badge",
        html: `<div style="
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: #f59e0b;
          color: #090d16;
          font-weight: 800;
          font-size: 11px;
          font-family: monospace;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid #ffffff;
          box-shadow: 0 0 8px rgba(245, 158, 11, 0.8);
          cursor: pointer;
        ">${i + 1}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      const marker = L.marker([lat, lng], { icon }).addTo(map);
      activeLayersRef.current.push(marker);
    });

    // Render connecting polyline / closed polygon
    if (points.length === 2) {
      const line = L.polyline(points, {
        color: "#f59e0b",
        weight: 2.5,
        dashArray: "5, 5",
      }).addTo(map);
      activeLayersRef.current.push(line);
    } else if (points.length >= 3) {
      const closed = [...points, points[0]!];
      const polygon = L.polygon(closed, {
        color: "#f59e0b",
        weight: 2.5,
        fillColor: "#f59e0b",
        fillOpacity: 0.2,
      }).addTo(map);
      activeLayersRef.current.push(polygon);
    }

    // Sync geometry into hidden form input for server-action submission
    const geometry = computeGeometry(points);
    const input = document.getElementById(hiddenInputId) as HTMLInputElement | null;
    if (input) {
      input.value = JSON.stringify(geometry);
    }
  }, [points, hiddenInputId]);

  const geometry = computeGeometry(points);
  const stationLabel = station || "Airport";

  return (
    <div className="space-y-2">
      <div className="relative w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Top Map HUD Bar */}
        <div className="absolute top-2.5 left-2.5 right-2.5 z-[1000] flex items-center justify-between pointer-events-none gap-2">
          {/* Station Airport Badge */}
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-[10px] font-mono font-medium shadow-md backdrop-blur border border-border/80 text-foreground">
            <span className="h-2 w-2 rounded-full bg-cyan-400" />
            <span className="font-semibold text-cyan-400">{stationLabel}</span>
            <span className="text-muted-foreground hidden sm:inline">AIRPORT MAP</span>
          </div>

          {/* Point Counter Status Pill */}
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-[10px] font-mono font-medium shadow-md backdrop-blur border border-border/80">
            {points.length === 0 ? (
              <>
                <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-amber-400 font-semibold">Tap map to add points (0/3 min)</span>
              </>
            ) : points.length < 3 ? (
              <>
                <span className="h-2 w-2 rounded-full bg-amber-400" />
                <span className="text-amber-400 font-bold">{points.length}/3 points placed</span>
                <span className="text-muted-foreground hidden sm:inline">(need {3 - points.length} more)</span>
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="text-emerald-400 font-bold">{points.length} points</span>
                <span className="text-muted-foreground">· radius ≈{geometry.radius_m}m</span>
              </>
            )}
          </div>
        </div>

        {/* Real Interactive Map Canvas */}
        <div
          ref={containerRef}
          className="w-full h-[280px] sm:h-[340px] md:h-[380px] z-0 select-none"
        />

        {/* Bottom Map Floating Quick-Controls */}
        <div className="absolute bottom-2.5 right-2.5 z-[1000] flex items-center gap-1.5 pointer-events-auto">
          <button
            type="button"
            onClick={handleResetOrFit}
            title="Fit view to points or station airport"
            className="flex items-center gap-1 rounded-lg bg-background/90 px-2.5 py-1 text-[10px] font-mono font-medium text-foreground shadow backdrop-blur border border-border/80 hover:bg-background transition-colors"
          >
            ⤢ {points.length >= 2 ? "Fit Polygon" : "Center Airport"}
          </button>
        </div>
      </div>

      {/* Editor Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <p className="font-mono text-[10px] text-muted-foreground">
          {points.length < 3
            ? "Tap or click the map to add boundary points (minimum 3 required to form a polygon)."
            : `${points.length} boundary points set · Estimated geofence radius: ${geometry.radius_m}m.`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-quiet text-xs"
            onClick={() => setPoints((prev) => prev.slice(0, -1))}
            disabled={points.length === 0}
          >
            ↺ Undo
          </button>
          <button
            type="button"
            className="btn-quiet text-xs"
            onClick={() => setPoints([])}
            disabled={points.length === 0}
          >
            ✕ Clear
          </button>
        </div>
      </div>
    </div>
  );
}
