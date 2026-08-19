"use client";

import dynamic from "next/dynamic";
import type { GeoPolygon } from "@/lib/avsec/duty/geofence";

// Leaflet touches window/document at module load — same reason DutyMap is loaded this
// way from CheckInScreen. This client-only wrapper is what lets a Server Component page
// (admin/zones) embed it without a next/dynamic({ssr:false}) call of its own, which
// Next.js only allows inside a Client Component.
const ZoneMapEditor = dynamic(() => import("./ZoneMapEditor"), {
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

export default function ZoneEditorLoader(props: { initialPolygon: GeoPolygon | null; hiddenInputId: string }) {
  return <ZoneMapEditor {...props} />;
}
