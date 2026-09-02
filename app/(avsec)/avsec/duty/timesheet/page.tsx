import Link from "next/link";
import { requireRole, DUTY_ROLES } from "@/lib/avsec/auth";
import { getTimesheetRoster, getTimesheetDuty } from "@/lib/avsec/duty/timesheet-queries";
import { scheduledWindow } from "@/lib/avsec/duty/lateness";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { DayTimeline } from "@/components/avsec/duty/DayTimeline";
import { todayISODateMY, formatTimeMY } from "@/lib/avsec/datetime";

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

const STATUS_CLASS: Record<string, string> = {
  present: "border-l-success text-success",
  late: "border-l-brand text-brand",
  absent: "border-l-brand text-brand",
};

export default async function TimesheetPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const searchParams = await searchParamsPromise;
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
    <main className="min-h-screen bg-background pb-28">
      <div className="flex items-center gap-3 border-b border-border px-6 py-[18px]">
        <Link
          href="/avsec/duty"
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center font-mono text-base text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr;
        </Link>
        <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">MY TIMESHEET</span>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="flex items-center justify-between">
          <Link
            href={`/avsec/duty/timesheet?week=${prevWeek}`}
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground"
          >
            ← Prev week
          </Link>
          <span className="font-mono text-[11px] text-muted-foreground">
            {dayLabel(weekStart)} – {dayLabel(weekEnd)}
          </span>
          <Link
            href={`/avsec/duty/timesheet?week=${nextWeek}`}
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:text-foreground"
          >
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

            const statusClass = duty
              ? (STATUS_CLASS[duty.status] ?? "border-l-border text-muted-foreground")
              : isOff || !roster
                ? "border-l-border text-muted-foreground"
                : date < today
                  ? "border-l-brand text-brand"
                  : "border-l-border text-muted-foreground/60";

            const card = (
              <div className={`vecta-panel space-y-2.5 border-l-[3px] !py-4 ${statusClass}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-foreground">
                    {dayLabel(date)}
                    {date === today ? " · Today" : ""}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.08em] ${statusClass}`}>
                    {label}
                  </span>
                </div>

                <p className="font-mono text-[10.5px] text-muted-foreground">
                  {roster && !isOff && roster.start_time && roster.end_time
                    ? `Scheduled ${roster.shift_code} · ${roster.start_time.slice(0, 5)}–${roster.end_time.slice(0, 5)}`
                    : isOff
                      ? "Scheduled OFF"
                      : "No roster set"}
                </p>

                {duty && (
                  <p className="text-[12.5px] text-foreground/90">
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
                  <p className="font-mono text-[10px] text-brand">
                    LATE {duty.late_minutes} MIN — {duty.late_remark}
                  </p>
                )}
                {duty && duty.early_out_minutes > 0 && (
                  <p className="font-mono text-[10px] text-brand">
                    EARLY OUT {duty.early_out_minutes} MIN — {duty.early_out_remark}
                  </p>
                )}
              </div>
            );

            return duty ? (
              <Link key={date} href={`/avsec/duty/view/${duty.id}`} className="block">
                {card}
              </Link>
            ) : (
              <div key={date}>{card}</div>
            );
          })}
        </div>
      </div>

      {/* DUTY_ROLES (ASO/SO/DSE) are never org-wide — see lib/avsec/auth.ts. */}
      <TeamBottomNav opsGroup={profile.ops_group} orgWide={false} />
    </main>
  );
}
