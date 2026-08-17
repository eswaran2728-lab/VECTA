"use client";

import dynamic from "next/dynamic";
import type { DutyZone } from "@/lib/duty/types";

// Same reason as every other Leaflet component here — window/document at module load
// means this must be client-only, loaded from a Client Component since a Server
// Component page can't call next/dynamic({ssr:false}) itself.
const ZonesMapView = dynamic(() => import("./ZonesMapView"), {
  ssr: false,
  loading: () => (
    <div
      className="h-[280px] flex items-center justify-center t-mono text-[10px]"
      style={{ color: "var(--faint)", background: "var(--panel2)" }}
    >
      Loading map…
    </div>
  ),
});

export default function ZonesMapViewLoader({ zones }: { zones: DutyZone[] }) {
  return <ZonesMapView zones={zones} />;
}
