"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DutyZone } from "@/lib/avsec/duty/types";

const KL_FALLBACK: [number, number] = [3.139, 101.6869];

/** Read-only zone outlines — no editing here, just orientation for anyone checking in. */
export default function ZonesMapView({ zones }: { zones: DutyZone[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] = zones[0] ? [zones[0].center_lat, zones[0].center_lng] : KL_FALLBACK;
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: false }).setView(center, 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
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
    layersRef.current.forEach((l) => l.remove());
    layersRef.current = [];

    zones.forEach((z) => {
      const ring = z.polygon?.coordinates?.[0];
      if (!ring) return;
      const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
      const poly = L.polygon(latlngs, { color: "#FFD900", weight: 2, fillOpacity: 0.08 })
        .addTo(map)
        .bindTooltip(z.name, { permanent: false, direction: "center" });
      layersRef.current.push(poly);
    });

    if (zones.length > 0) {
      const bounds = L.latLngBounds(zones.map((z) => [z.center_lat, z.center_lng] as [number, number]));
      map.fitBounds(bounds.pad(0.4));
    }
  }, [zones]);

  return <div ref={containerRef} style={{ width: "100%", height: "280px" }} />;
}
