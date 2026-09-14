"use client";

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DutyZone } from "@/lib/avsec/duty/types";

const KL_FALLBACK: [number, number] = [3.139, 101.6869];

interface DutyMapProps {
  position: { lat: number; lng: number; accuracy: number } | null;
  zones: DutyZone[];
  insideZone?: DutyZone | null;
  locating?: boolean;
  station?: string | null;
}

export default function DutyMap({
  position,
  zones,
  insideZone,
  locating = false,
  station,
}: DutyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const accuracyRef = useRef<L.Circle | null>(null);
  const zoneLayersRef = useRef<L.Polygon[]>([]);
  const hasFittedInitialBoundsRef = useRef(false);

  // Helper to calculate bounds of all zones + position
  const getOverallBounds = useCallback(() => {
    const latLngs: [number, number][] = [];

    for (const zone of zones) {
      const ring = zone.polygon?.coordinates?.[0];
      if (ring) {
        for (const [lng, lat] of ring) {
          latLngs.push([lat, lng]);
        }
      } else if (zone.center_lat && zone.center_lng) {
        latLngs.push([zone.center_lat, zone.center_lng]);
      }
    }

    if (position) {
      latLngs.push([position.lat, position.lng]);
    }

    if (latLngs.length === 0) return null;
    return L.latLngBounds(latLngs);
  }, [zones, position]);

  const fitAllBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const bounds = getOverallBounds();
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18, animate: true });
    } else if (position) {
      map.setView([position.lat, position.lng], 17, { animate: true });
    }
  }, [getOverallBounds, position]);

  const centerOnPosition = useCallback(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    map.setView([position.lat, position.lng], 17, { animate: true });
  }, [position]);

  // Map instance — created once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const firstZone = zones[0];
    const initialCenter: [number, number] = position
      ? [position.lat, position.lng]
      : firstZone
        ? [firstZone.center_lat, firstZone.center_lng]
        : KL_FALLBACK;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView(initialCenter, 16);

    // High quality standard OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      subdomains: ["a", "b", "c"],
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      hasFittedInitialBoundsRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zone polygon overlays — render each duty zone with clear boundary styling and tooltips
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    zoneLayersRef.current.forEach((layer) => layer.remove());
    zoneLayersRef.current = [];

    for (const zone of zones) {
      const ring = zone.polygon?.coordinates?.[0];
      if (!ring || ring.length < 3) continue;

      const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
      const isCurrentZone = insideZone?.id === zone.id;

      // Cyan outline for normal zones, green glow if user is inside this specific zone
      const layer = L.polygon(latlngs, {
        color: isCurrentZone ? "#56d57b" : "#12cbf5",
        weight: isCurrentZone ? 3 : 2,
        fillColor: isCurrentZone ? "#56d57b" : "#12cbf5",
        fillOpacity: isCurrentZone ? 0.18 : 0.09,
        dashArray: isCurrentZone ? undefined : "4, 4",
      }).addTo(map);

      layer.bindTooltip(
        `<div style="font-family: monospace; font-size: 11px; font-weight: bold; padding: 2px 4px;">
          ${zone.name} <span style="opacity: 0.7;">(${zone.code})</span>
          ${isCurrentZone ? " <span style='color: #56d57b;'>● ACTIVE</span>" : ""}
        </div>`,
        { permanent: false, sticky: true, className: "vecta-map-tooltip" }
      );

      zoneLayersRef.current.push(layer);
    }
  }, [zones, insideZone]);

  // Current position marker + accuracy circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!position) {
      markerRef.current?.remove();
      accuracyRef.current?.remove();
      markerRef.current = null;
      accuracyRef.current = null;
      return;
    }

    markerRef.current?.remove();
    accuracyRef.current?.remove();

    // Radar green marker with white inner highlight
    markerRef.current = L.circleMarker([position.lat, position.lng], {
      radius: 8,
      color: "#ffffff",
      fillColor: "#56d57b",
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    markerRef.current.bindTooltip(
      `<div style="font-family: monospace; font-size: 11px; font-weight: bold; color: #56d57b;">
        ● You are here (±${Math.round(position.accuracy)}m)
      </div>`,
      { permanent: false, sticky: true }
    );

    // Accuracy halo
    accuracyRef.current = L.circle([position.lat, position.lng], {
      radius: position.accuracy,
      color: "#56d57b",
      weight: 1,
      fillOpacity: 0.08,
      fillColor: "#56d57b",
    }).addTo(map);

    // Fit bounds on first acquisition if not already fitted
    if (!hasFittedInitialBoundsRef.current) {
      hasFittedInitialBoundsRef.current = true;
      const bounds = getOverallBounds();
      if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18, animate: true });
      } else {
        map.setView([position.lat, position.lng], 17);
      }
    }
  }, [position, getOverallBounds]);

  // Initial bounds fit when zones are available
  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasFittedInitialBoundsRef.current || zones.length === 0) return;

    const bounds = getOverallBounds();
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
      hasFittedInitialBoundsRef.current = true;
    }
  }, [zones, getOverallBounds]);

  const activeStationName = station || zones[0]?.station || "Station";

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Top Map HUD Bar */}
      <div className="absolute top-2.5 left-2.5 right-2.5 z-[1000] flex items-center justify-between pointer-events-none gap-2">
        {/* GPS Lock Pill */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-[10px] font-mono font-medium shadow-md backdrop-blur border border-border/80 text-foreground">
          {locating ? (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-amber-400 font-semibold">ACQUIRING GPS...</span>
            </>
          ) : position ? (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-emerald-400 font-bold">GPS LOCKED</span>
              <span className="text-muted-foreground">±{Math.round(position.accuracy)}m</span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              <span className="text-rose-400 font-semibold">NO GPS FIX</span>
            </>
          )}
        </div>

        {/* Geofence Status Pill */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-[10px] font-mono font-medium shadow-md backdrop-blur border border-border/80">
          {insideZone ? (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-emerald-400 font-bold">INSIDE: {insideZone.name}</span>
            </>
          ) : position ? (
            <>
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              <span className="text-rose-400 font-bold">OUTSIDE GEOFENCE</span>
            </>
          ) : (
            <span className="text-muted-foreground">AWAITING LOCATION</span>
          )}
        </div>
      </div>

      {/* Real Map Canvas */}
      <div ref={containerRef} className="w-full h-[260px] z-0" />

      {/* Bottom Map Controls & Info Bar */}
      <div className="absolute bottom-2.5 left-2.5 right-2.5 z-[1000] flex items-center justify-between pointer-events-none gap-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-background/90 px-2 py-1 text-[10px] font-mono text-muted-foreground shadow backdrop-blur border border-border/70">
          <span className="font-semibold text-foreground">{activeStationName}</span>
          <span>·</span>
          <span>
            {zones.length} {zones.length === 1 ? "Duty Zone" : "Duty Zones"}
          </span>
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={fitAllBounds}
            title="Fit duty zones and location"
            className="flex items-center gap-1 rounded-lg bg-background/90 px-2 py-1 text-[10px] font-mono font-medium text-foreground shadow backdrop-blur border border-border/80 hover:bg-background transition-colors"
          >
            ⤢ Fit
          </button>
          {position && (
            <button
              type="button"
              onClick={centerOnPosition}
              title="Center on my GPS position"
              className="flex items-center gap-1 rounded-lg bg-background/90 px-2 py-1 text-[10px] font-mono font-medium text-primary shadow backdrop-blur border border-border/80 hover:bg-background transition-colors"
            >
              📍 My Location
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
