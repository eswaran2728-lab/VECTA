import Link from "next/link";
import { requireRole, DUTY_ROLES } from "@/lib/auth";
import { getTodayRoster, getTodayDutyRecord } from "@/lib/duty/checkin-queries";
import { getZonesForStation } from "@/lib/duty/zone-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { CheckInScreen } from "@/components/duty/CheckInScreen";

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
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} />
      <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        <h1 className="t-display text-2xl">Duty Check-In</h1>
        <CheckInScreen roster={roster} zones={zones} record={record} />

        <div className="flex items-center justify-between gap-2 pt-2">
          <Link href="/duty/timesheet" className="btn-quiet">
            My Timesheet →
          </Link>
          <Link href="/duty/overtime" className="btn-quiet">
            Overtime →
          </Link>
        </div>
        <Link href="/duty/zones" className="btn-quiet block text-center">
          View Duty Zones →
        </Link>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
