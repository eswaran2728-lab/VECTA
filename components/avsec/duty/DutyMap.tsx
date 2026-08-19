"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DutyZone } from "@/lib/avsec/duty/types";

const KL_FALLBACK: [number, number] = [3.139, 101.6869];

export default function DutyMap({
  position,
  zones,
}: {
  position: { lat: number; lng: number; accuracy: number } | null;
  zones: DutyZone[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const accuracyRef = useRef<L.Circle | null>(null);
  const zoneLayersRef = useRef<L.Polygon[]>([]);

  // Map instance — created once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const firstZone = zones[0];
    const center: [number, number] = position
      ? [position.lat, position.lng]
      : firstZone
        ? [firstZone.center_lat, firstZone.center_lng]
        : KL_FALLBACK;

    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: false }).setView(center, 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zone polygon overlays — every marked zone for the station, not just one.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    zoneLayersRef.current.forEach((layer) => layer.remove());
    zoneLayersRef.current = [];

    for (const zone of zones) {
      const ring = zone.polygon?.coordinates?.[0];
      if (!ring) continue;
      const latlngs = ring.map(([lng, lat]) => [lat, lng] as [number, number]);
      const layer = L.polygon(latlngs, { color: "#FFD900", weight: 2, fillOpacity: 0.08 }).addTo(map);
      zoneLayersRef.current.push(layer);
    }
  }, [zones]);

  // Current position marker + accuracy ring.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;

    markerRef.current?.remove();
    accuracyRef.current?.remove();

    markerRef.current = L.circleMarker([position.lat, position.lng], {
      radius: 8,
      color: "#FFD900",
      fillColor: "#FFD900",
      fillOpacity: 1,
      weight: 2,
    }).addTo(map);

    accuracyRef.current = L.circle([position.lat, position.lng], {
      radius: position.accuracy,
      color: "#7FA8FF",
      weight: 1,
      fillOpacity: 0.05,
    }).addTo(map);

    map.setView([position.lat, position.lng], map.getZoom());
  }, [position]);

  return <div ref={containerRef} style={{ width: "100%", height: "220px" }} />;
}
