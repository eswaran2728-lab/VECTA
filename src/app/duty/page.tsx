import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { getTodayRoster, getDutyZone, getTodayDutyRecord } from "@/lib/duty/checkin-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { CheckInScreen } from "@/components/duty/CheckInScreen";

export default async function DutyPage() {
  const profile = await requireProfile();

  const roster = profile.station ? await getTodayRoster(profile.station, profile.team ?? "") : null;
  const [zone, record] = await Promise.all([
    roster?.zone_id ? getDutyZone(roster.zone_id) : Promise.resolve(null),
    roster ? getTodayDutyRecord(profile.id, roster.shift_code) : Promise.resolve(null),
  ]);

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} />
      <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        <h1 className="t-display text-2xl">Duty Check-In</h1>
        <CheckInScreen roster={roster} zone={zone} record={record} />

        <div className="flex items-center justify-between gap-2 pt-2">
          <Link href="/duty/timesheet" className="btn-quiet">
            My Timesheet →
          </Link>
          <Link href="/duty/overtime" className="btn-quiet">
            Overtime →
          </Link>
        </div>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
