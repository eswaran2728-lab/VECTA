"use client";

import dynamic from "next/dynamic";
import type { DutyZone } from "@/lib/avsec/duty/types";

// Same reason as every other Leaflet component here — window/document at module load
// means this must be client-only, loaded from a Client Component since a Server
// Component page can't call next/dynamic({ssr:false}) itself.
const ZonesMapView = dynamic(() => import("./ZonesMapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[280px] items-center justify-center bg-card font-mono text-[10px] text-muted-foreground">
      Loading map…
    </div>
  ),
});

export default function ZonesMapViewLoader({ zones }: { zones: DutyZone[] }) {
  return <ZonesMapView zones={zones} />;
}
