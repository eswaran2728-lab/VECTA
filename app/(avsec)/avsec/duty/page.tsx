import Link from "next/link";
import { requireRole, DUTY_ROLES } from "@/lib/avsec/auth";
import { getTodayRoster, getTodayDutyRecord } from "@/lib/avsec/duty/checkin-queries";
import { getZonesForStation } from "@/lib/avsec/duty/zone-queries";
import { CheckInScreen } from "@/components/avsec/duty/CheckInScreen";

export default async function DutyPage() {
  const profile = await requireRole(DUTY_ROLES);

  const roster = profile.station ? await getTodayRoster(profile.station, profile.team ?? "") : null;
  const [allZones, record] = await Promise.all([
    profile.station ? getZonesForStation(profile.station) : Promise.resolve([]),
    roster ? getTodayDutyRecord(profile.id, roster.shift_code) : Promise.resolve(null),
  ]);
  // Every team checks in/out at any of the station's marked zones, not one assigned per
  // shift — so this is every active zone for the station, not roster-specific.
  const zones = allZones.filter((z) => z.active);

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
            DUTY CHECK-IN
          </span>
          <span className="vecta-chip">
            {profile.station ?? "—"}
            {profile.team ? ` · ${profile.team}` : ""}
          </span>
        </div>
        <CheckInScreen roster={roster} zones={zones} record={record} />

        <div className="flex items-center justify-between gap-2 pt-2">
          <Link
            href="/avsec/duty/timesheet"
            className="rounded-full border border-border px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            My Timesheet →
          </Link>
          <Link
            href="/avsec/duty/overtime"
            className="rounded-full border border-border px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            Overtime →
          </Link>
        </div>
        <Link
          href="/avsec/duty/zones"
          className="block rounded-full border border-border px-4 py-2.5 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
        >
          View Duty Zones →
        </Link>
      </div>

      {/* DUTY_ROLES (ASO/SO/DSE) are never org-wide — see lib/avsec/auth.ts. */}
    </main>
  );
}
