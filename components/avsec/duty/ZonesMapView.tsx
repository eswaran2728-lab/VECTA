"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DutyZone } from "@/lib/avsec/duty/types";
import { STATION_AIRPORT_COORDS } from "./ZoneMapEditor";

const DEFAULT_AIRPORT: [number, number] = [2.7433, 101.6981]; // KLIA klia2

/** Read-only zone outlines — no editing here, just orientation for staff viewing station zones. */
export default function ZonesMapView({
  zones,
  station,
}: {
  zones: DutyZone[];
  station?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  const stationAirport: [number, number] =
    (station && STATION_AIRPORT_COORDS[station]) || DEFAULT_AIRPORT;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] = zones[0]
      ? [zones[0].center_lat, zones[0].center_lng]
      : stationAirport;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView(center, 15);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      subdomains: ["a", "b", "c"],
    }).addTo(map);

    mapRef.current = map;

    const t1 = setTimeout(() => map.invalidateSize(), 100);
    const t2 = setTimeout(() => map.invalidateSize(), 300);

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach((l) => l.remove());
    layersRef.current = [];

    const zonePoints: [number, number][] = [];

    zones.forEach((z) => {
      const ring = z.polygon?.coordinates?.[0];
      if (!ring) return;
      const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
      latlngs.forEach((pt) => zonePoints.push(pt));

      const poly = L.polygon(latlngs, {
        color: "#12cbf5",
        weight: 2,
        fillColor: "#12cbf5",
        fillOpacity: 0.12,
      })
        .addTo(map)
        .bindTooltip(
          `<div style="font-family: monospace; font-size: 11px; font-weight: bold;">
            ${z.name} <span style="opacity: 0.7;">(${z.code})</span>
          </div>`,
          { permanent: false, sticky: true }
        );
      layersRef.current.push(poly);
    });

    if (zonePoints.length > 0) {
      const bounds = L.latLngBounds(zonePoints);
      map.fitBounds(bounds.pad(0.3), { maxZoom: 17 });
    } else {
      map.setView(stationAirport, 15);
    }
  }, [zones, stationAirport]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[280px] sm:h-[340px] z-0 select-none"
    />
  );
}
