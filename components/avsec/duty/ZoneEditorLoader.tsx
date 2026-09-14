"use client";

import dynamic from "next/dynamic";
import type { GeoPolygon } from "@/lib/avsec/duty/geofence";
import type { DutyZone } from "@/lib/avsec/duty/types";

// Leaflet touches window/document at module load — same reason DutyMap is loaded this
// way from CheckInScreen. This client-only wrapper is what lets a Server Component page
// (admin/zones) embed it without a next/dynamic({ssr:false}) call of its own, which
// Next.js only allows inside a Client Component.
const ZoneMapEditor = dynamic(() => import("./ZoneMapEditor"), {
  ssr: false,
  loading: () => (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="h-[280px] sm:h-[340px] md:h-[380px] flex flex-col items-center justify-center gap-2 font-mono text-xs text-muted-foreground bg-muted/20">
        <span className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        <span>Loading interactive map…</span>
      </div>
    </div>
  ),
});

export default function ZoneEditorLoader(props: {
  initialPolygon: GeoPolygon | null;
  hiddenInputId: string;
  station?: string;
  existingZones?: DutyZone[];
}) {
  return <ZoneMapEditor {...props} />;
}
