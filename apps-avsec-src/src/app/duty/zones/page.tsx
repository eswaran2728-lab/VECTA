import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { STATIONS } from "@/lib/reference-data";
import { getZonesForStation } from "@/lib/duty/zone-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import ZonesMapViewLoader from "@/components/duty/ZonesMapViewLoader";

export default async function DutyZonesViewPage({
  searchParams,
}: {
  searchParams: { station?: string };
}) {
  const profile = await requireProfile();
  const station = searchParams.station || profile.station || STATIONS[0];

  const allZones = await getZonesForStation(station);
  const zones = allZones.filter((z) => (z as { active?: boolean }).active !== false);

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Duty Zones" backHref="/duty" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <p className="text-[13px]" style={{ color: "var(--soft)" }}>
          Geofence areas the check-in screen tests against.
          {profile.role === "ADMIN" && (
            <>
              {" "}
              <Link href="/admin/zones" className="btn-quiet inline">
                Edit zones →
              </Link>
            </>
          )}
        </p>

        <form method="get" className="card p-4 flex items-end gap-3">
          <div>
            <label className="field-label">Station</label>
            <select name="station" defaultValue={station} className="input-base">
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-secondary">
            Switch
          </button>
        </form>

        <div className="card overflow-hidden">
          <ZonesMapViewLoader zones={zones} />
        </div>

        <div className="space-y-2">
          {zones.length === 0 && (
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              No duty zones defined yet for {station}.
            </p>
          )}
          {zones.map((z) => (
            <div key={z.id} className="card p-4 flex items-center justify-between">
              <div>
                <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                  {z.code} · {z.name}
                </p>
                <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
                  radius ≈{z.radius_m}m
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
