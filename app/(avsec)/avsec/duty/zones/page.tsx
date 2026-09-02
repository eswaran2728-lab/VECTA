import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { STATIONS, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { getZonesForStation } from "@/lib/avsec/duty/zone-queries";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import ZonesMapViewLoader from "@/components/avsec/duty/ZonesMapViewLoader";

export default async function DutyZonesViewPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ station?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const station = searchParams.station || profile.station || STATIONS[0];

  const allZones = await getZonesForStation(station);
  const zones = allZones.filter((z) => (z as { active?: boolean }).active !== false);

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="flex items-center gap-3 border-b border-border px-6 py-[18px]">
        <Link
          href="/avsec/duty"
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center font-mono text-base text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr;
        </Link>
        <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">DUTY ZONES</span>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <p className="text-[13px] text-muted-foreground">
          Geofence areas the check-in screen tests against.
          {profile.role === "ADMIN" && (
            <>
              {" "}
              <Link href="/avsec/admin/zones" className="text-primary hover:underline">
                Edit zones →
              </Link>
            </>
          )}
        </p>

        <form method="get" className="vecta-panel flex items-end gap-3 !py-4">
          <div>
            <label className="vecta-label">Station</label>
            <select name="station" defaultValue={station} className="vecta-input">
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="rounded-full border border-border px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            Switch
          </button>
        </form>

        <div className="vecta-panel overflow-hidden !p-0">
          <ZonesMapViewLoader zones={zones} />
        </div>

        <div className="space-y-2">
          {zones.length === 0 && (
            <p className="text-sm text-muted-foreground">No duty zones defined yet for {station}.</p>
          )}
          {zones.map((z) => (
            <div key={z.id} className="vecta-panel flex items-center justify-between !py-4">
              <div>
                <p className="text-[13px] font-semibold text-foreground">
                  {z.code} · {z.name}
                </p>
                <p className="font-mono text-[10px] text-muted-foreground">radius ≈{z.radius_m}m</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} />
    </main>
  );
}
