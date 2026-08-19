"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import type { DutyZone } from "@/lib/avsec/duty/types";

const KL_FALLBACK: [number, number] = [3.139, 101.6869];

export interface HeatMapPoint {
  lat: number;
  lng: number;
  label: string;
}

export default function HeatMap({
  points,
  zones,
  view,
}: {
  points: HeatMapPoint[];
  zones: DutyZone[];
  view: "heat" | "pins";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] = points[0]
      ? [points[0].lat, points[0].lng]
      : zones[0]
        ? [zones[0].center_lat, zones[0].center_lng]
        : KL_FALLBACK;

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
      const poly = L.polygon(latlngs, { color: "#7FA8FF", weight: 1.5, fillOpacity: 0.03, dashArray: "4 4" }).addTo(map);
      layersRef.current.push(poly);
    });

    if (view === "heat" && points.length > 0) {
      const heat = L.heatLayer(
        points.map((p) => [p.lat, p.lng, 0.6]),
        { radius: 35, blur: 25, maxZoom: 17 },
      ).addTo(map);
      layersRef.current.push(heat);
    }

    if (view === "pins") {
      points.forEach((p) => {
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: 7,
          color: "#FFD900",
          fillColor: "#FFD900",
          fillOpacity: 0.9,
          weight: 1.5,
        })
          .addTo(map)
          .bindPopup(p.label);
        layersRef.current.push(marker);
      });
    }

    if (points.length > 0) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
      map.fitBounds(bounds.pad(0.3));
    }
  }, [points, zones, view]);

  return <div ref={containerRef} style={{ width: "100%", height: "320px" }} />;
}
