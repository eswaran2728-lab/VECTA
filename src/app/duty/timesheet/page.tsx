import Link from "next/link";
import { requireRole, DUTY_ROLES } from "@/lib/auth";
import { getTimesheetRoster, getTimesheetDuty } from "@/lib/duty/timesheet-queries";
import { scheduledWindow } from "@/lib/duty/lateness";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { DayTimeline } from "@/components/duty/DayTimeline";
import { todayISODateMY, formatTimeMY } from "@/lib/datetime";

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(dateStr, diff);
}

function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

const STATUS_COLOR: Record<string, string> = {
  present: "var(--green)",
  late: "var(--red)",
  absent: "var(--red)",
};

export default async function TimesheetPage({
  searchParams,
}: {
  searchParams: { week?: string };
}) {
  const profile = await requireRole(DUTY_ROLES);
  const weekStart = mondayOf(searchParams.week || todayISODateMY());
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = todayISODateMY();

  const [rosterRows, dutyRows] = await Promise.all([
    profile.station ? getTimesheetRoster(profile.station, profile.team ?? "", weekStart, weekEnd) : Promise.resolve([]),
    getTimesheetDuty(profile.id, weekStart, weekEnd),
  ]);

  const rosterByDate = new Map(rosterRows.map((r) => [r.roster_date, r]));
  const dutyByDate = new Map(dutyRows.map((r) => [r.duty_date, r]));

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="My Timesheet" backHref="/profile" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <Link href={`/duty/timesheet?week=${prevWeek}`} className="btn-quiet">
            ← Prev week
          </Link>
          <span className="t-mono text-[11px]" style={{ color: "var(--soft)" }}>
            {dayLabel(weekStart)} – {dayLabel(weekEnd)}
          </span>
          <Link href={`/duty/timesheet?week=${nextWeek}`} className="btn-quiet">
            Next week →
          </Link>
        </div>

        <div className="space-y-3">
          {days.map((date) => {
            const roster = rosterByDate.get(date);
            const duty = dutyByDate.get(date);
            const isOff = roster?.shift_code === "OFF";
            const scheduled =
              roster?.start_time && roster?.end_time && !isOff
                ? scheduledWindow(date, roster.start_time, roster.end_time)
                : null;
            const checkIn = duty?.check_in_at ? new Date(duty.check_in_at) : null;
            const checkOut = duty?.check_out_at ? new Date(duty.check_out_at) : null;

            const label = duty
              ? duty.status.toUpperCase().replace("_", " ")
              : isOff
                ? "OFF"
                : !roster
                  ? "NO ROSTER"
                  : date < today
                    ? "MISSED"
                    : date === today
                      ? "PENDING"
                      : "UPCOMING";

            const statusColor = duty
              ? (STATUS_COLOR[duty.status] ?? "var(--faint)")
              : isOff || !roster
                ? "var(--faint)"
                : date < today
                  ? "var(--red)"
                  : "var(--faintest)";

            const card = (
              <div className="card p-4 space-y-2.5" style={{ borderLeft: `3px solid ${statusColor}` }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[13px]" style={{ color: "var(--ink)" }}>
                    {dayLabel(date)}
                    {date === today ? " · Today" : ""}
                  </span>
                  <span
                    className="t-mono text-[8.5px] font-bold px-2 py-0.5"
                    style={{ letterSpacing: "0.08em", color: statusColor, border: `1px solid ${statusColor}` }}
                  >
                    {label}
                  </span>
                </div>

                <p className="t-mono text-[10.5px]" style={{ color: "var(--soft)" }}>
                  {roster && !isOff && roster.start_time && roster.end_time
                    ? `Scheduled ${roster.shift_code} · ${roster.start_time.slice(0, 5)}–${roster.end_time.slice(0, 5)}`
                    : isOff
                      ? "Scheduled OFF"
                      : "No roster set"}
                </p>

                {duty && (
                  <p className="text-[12.5px]" style={{ color: "var(--ink2)" }}>
                    {checkIn ? `In ${formatTimeMY(duty.check_in_at)}` : "—"}
                    {" · "}
                    {checkOut ? `Out ${formatTimeMY(duty.check_out_at)}` : checkIn ? "still on duty" : "—"}
                  </p>
                )}

                {(scheduled || checkIn || checkOut) && (
                  <DayTimeline
                    scheduledStart={scheduled?.start ?? null}
                    scheduledEnd={scheduled?.end ?? null}
                    checkIn={checkIn}
                    checkOut={checkOut}
                  />
                )}

                {duty && duty.late_minutes > 0 && (
                  <p className="t-mono text-[10px]" style={{ color: "var(--red)" }}>
                    LATE {duty.late_minutes} MIN — {duty.late_remark}
                  </p>
                )}
                {duty && duty.early_out_minutes > 0 && (
                  <p className="t-mono text-[10px]" style={{ color: "var(--red)" }}>
                    EARLY OUT {duty.early_out_minutes} MIN — {duty.early_out_remark}
                  </p>
                )}
              </div>
            );

            return duty ? (
              <Link key={date} href={`/duty/view/${duty.id}`} className="block">
                {card}
              </Link>
            ) : (
              <div key={date}>{card}</div>
            );
          })}
        </div>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
