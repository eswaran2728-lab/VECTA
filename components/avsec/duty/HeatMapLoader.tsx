"use client";

import dynamic from "next/dynamic";
import type { DutyZone } from "@/lib/avsec/duty/types";
import type { HeatMapPoint } from "./HeatMap";

// Same reason as ZoneEditorLoader/DutyMap — Leaflet touches window/document at module
// load, so this must be client-only, loaded from a Client Component wrapper since a
// Server Component page can't call next/dynamic({ssr:false}) itself.
const HeatMap = dynamic(() => import("./HeatMap"), {
  ssr: false,
  loading: () => (
    <div
      className="h-[320px] flex items-center justify-center t-mono text-[10px]"
      style={{ color: "var(--faint)", background: "var(--panel2)" }}
    >
      Loading map…
    </div>
  ),
});

export default function HeatMapLoader(props: { points: HeatMapPoint[]; zones: DutyZone[]; view: "heat" | "pins" }) {
  return <HeatMap {...props} />;
}
