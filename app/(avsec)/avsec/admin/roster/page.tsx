import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { STATIONS } from "@/lib/avsec/reference-data";
import {
  getShifts,
  getRosterOfficers,
  getRosterWeek,
  getStationTeams,
  getApprovedLeavesForRoster,
  type RosterCell as RosterCellRow,
} from "@/lib/avsec/duty/roster-queries";
import { formatOnLeaveLabel, type LeaveType } from "@/lib/avsec/duty/absence-logic";
import { addStationTeam, setTeamScheduleRange, deleteShift } from "@/lib/avsec/duty/roster-actions";
import { RosterCell } from "@/components/avsec/admin/RosterCell";
import { CreateScheduleForm } from "@/components/avsec/admin/CreateScheduleForm";
import { todayISODateMY } from "@/lib/avsec/datetime";
import { initials } from "@/lib/avsec/utils";

const PAGE_SIZE = 20;

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

export default async function AdminRosterPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ station?: string; week?: string; q?: string; page?: string; error?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(ADMIN_ROLES);

  const station = searchParams.station || profile.station || STATIONS[0];
  const weekStart = mondayOf(searchParams.week || todayISODateMY());
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = todayISODateMY();
  const search = searchParams.q || "";
  const page = Math.max(1, Number(searchParams.page) || 1);

  const [shifts, officers, rosterRows, stationTeams, approvedLeaves] = await Promise.all([
    getShifts(),
    getRosterOfficers(station, search),
    getRosterWeek(station, weekStart, weekEnd),
    getStationTeams(station),
    getApprovedLeavesForRoster(station, weekStart, weekEnd),
  ]);

  const cellMap = new Map<string, RosterCellRow>();
  for (const row of rosterRows) cellMap.set(`${row.team}|${row.roster_date}`, row);

  // Map approved leaves to officer ID and date
  const officerLeaveMap = new Map<string, { leaveType: LeaveType; leaveLabel: string }>();
  for (const leave of approvedLeaves) {
    for (const date of days) {
      if (leave.start_date <= date && leave.end_date >= date) {
        officerLeaveMap.set(`${leave.user_id}|${date}`, {
          leaveType: leave.leave_type,
          leaveLabel: formatOnLeaveLabel(leave.leave_type),
        });
      }
    }
  }

  // Detect coverage conflicts (approved leave overlapping an active working shift)
  const coverageConflicts: Array<{
    officerName: string;
    officerStaffNo: string;
    team: string;
    date: string;
    shiftCode: string;
    leaveLabel: string;
  }> = [];

  for (const o of officers) {
    for (const date of days) {
      const leave = officerLeaveMap.get(`${o.id}|${date}`);
      const cell = cellMap.get(`${o.team}|${date}`);
      if (leave && cell && cell.shift_code && cell.shift_code.toUpperCase() !== "OFF") {
        coverageConflicts.push({
          officerName: o.name,
          officerStaffNo: o.staff_no,
          team: o.team,
          date,
          shiftCode: cell.shift_code,
          leaveLabel: leave.leaveLabel,
        });
      }
    }
  }

  const totalPages = Math.max(1, Math.ceil(officers.length / PAGE_SIZE));
  const pageOfficers = officers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);

  const qs = (overrides: Record<string, string>) => {
    const params = new URLSearchParams({ station, week: weekStart, q: search, ...overrides });
    if (!params.get("q")) params.delete("q");
    return params.toString();
  };

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">Team Roster</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Admin-entered, day by day. One row per officer for easy scanning — but a cell
            still sets the shift for that officer&apos;s <strong className="text-foreground">whole team</strong>, exactly
            as before. Editing any officer&apos;s cell updates everyone on their team for that day.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        {/* Coverage Conflict Alert Banner */}
        {coverageConflicts.length > 0 && (
          <div className="card p-4 border-l-4 border-l-rose-500 bg-rose-500/5 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="text-base">⚠️</span>
                <span className="font-display text-sm font-bold text-rose-400 uppercase tracking-wide">
                  Coverage Reassignment Needed ({coverageConflicts.length} Conflict{coverageConflicts.length > 1 ? "s" : ""})
                </span>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                Manual DSE Reassignment Required
              </span>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              The following officers have approved leave overlapping an active scheduled shift. Coverage is not automatically reassigned:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
              {coverageConflicts.map((c, i) => (
                <div
                  key={i}
                  className="p-2.5 rounded bg-background/80 border border-rose-500/30 text-xs font-mono space-y-0.5"
                >
                  <div className="font-bold text-foreground flex items-center justify-between">
                    <span>{c.officerName}</span>
                    <span className="text-[10px] text-rose-400">{c.team}</span>
                  </div>
                  <div className="text-muted-foreground text-[11px]">
                    {dayLabel(c.date)} · Shift: <strong className="text-foreground">{c.shiftCode}</strong>
                  </div>
                  <div className="text-amber-400 text-[10px] font-semibold">
                    {c.leaveLabel}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card p-4 flex flex-wrap items-end gap-3">
          <form method="get" className="flex items-end gap-3 flex-wrap">
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
            <div>
              <label className="field-label">Search officer</label>
              <input
                type="text"
                name="q"
                defaultValue={search}
                placeholder="Name…"
                className="input-base"
              />
            </div>
            <input type="hidden" name="week" value={weekStart} />
            <button type="submit" className="btn-secondary">
              Filter
            </button>
          </form>

          <div className="flex items-center gap-2 ml-auto">
            <Link href={`/avsec/admin/roster?${qs({ week: prevWeek, page: "1" })}`} className="btn-quiet">
              ← Prev week
            </Link>
            <span className="font-mono text-[11px] text-muted-foreground">
              {dayLabel(weekStart)} – {dayLabel(weekEnd)}
            </span>
            <Link href={`/avsec/admin/roster?${qs({ week: today, page: "1" })}`} className="btn-quiet">
              Today
            </Link>
            <Link href={`/avsec/admin/roster?${qs({ week: nextWeek, page: "1" })}`} className="btn-quiet">
              Next week →
            </Link>
          </div>
        </div>

        {officers.length === 0 ? (
          <div className="card p-5 space-y-3">
            <p className="text-sm text-muted-foreground">
              {search
                ? `No officers matching "${search}" at ${station}.`
                : `No ASO/SO/DSE officers found at ${station} yet.`}
            </p>
            <form action={addStationTeam} className="flex gap-2">
              <input type="hidden" name="station" value={station} />
              <input type="text" name="team" placeholder="e.g. ALPHA" required className="input-base flex-1" />
              <button type="submit" className="btn-primary">
                Add team
              </button>
            </form>
          </div>
        ) : (
          <div className="card p-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Officer
                  </th>
                  {days.map((date) => (
                    <th
                      key={date}
                      className={`text-left p-2 font-mono text-[10px] uppercase tracking-wider ${
                        date === today ? "text-primary font-bold" : "text-muted-foreground"
                      }`}
                    >
                      {dayLabel(date)}
                      {date === today && (
                        <span className="block w-1.5 h-1.5 rounded-full mt-1 bg-primary" />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pageOfficers.map((o) => (
                  <tr key={o.id} className="hover:bg-card/40 transition-colors">
                    <td className="p-2 align-top whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center font-mono text-[9.5px] font-bold bg-primary/20 text-primary border border-primary/30">
                          {initials(o.name)}
                        </span>
                        <div>
                          <p className="font-semibold text-xs text-foreground">
                            {o.name}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {o.staff_no} · {o.team || "—"}
                          </p>
                        </div>
                      </div>
                    </td>
                    {days.map((date) => {
                      const leaveInfo = officerLeaveMap.get(`${o.id}|${date}`);
                      return (
                        <td key={date} className="p-1 align-top min-w-[140px]">
                          {o.team ? (
                            <RosterCell
                              station={station}
                              team={o.team}
                              date={date}
                              week={weekStart}
                              shifts={shifts}
                              cell={cellMap.get(`${o.team}|${date}`)}
                              leaveInfo={leaveInfo}
                            />
                          ) : (
                            <p className="font-mono text-[10px] p-2 text-muted-foreground/60">
                              No team set
                            </p>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {officers.length} officers · page {page} / {totalPages}
                </span>
                <div className="flex gap-2">
                  {page > 1 && (
                    <Link href={`/avsec/admin/roster?${qs({ page: String(page - 1) })}`} className="btn-quiet">
                      ← Prev
                    </Link>
                  )}
                  {page < totalPages && (
                    <Link href={`/avsec/admin/roster?${qs({ page: String(page + 1) })}`} className="btn-quiet">
                      Next →
                    </Link>
                  )}
                </div>
              </div>
            )}

            <form action={addStationTeam} className="flex gap-2 mt-4 pt-4 border-t border-border">
              <input type="hidden" name="station" value={station} />
              <input
                type="text"
                name="team"
                placeholder="Add another team…"
                required
                className="input-base flex-1 max-w-xs"
              />
              <button type="submit" className="btn-secondary">
                Add team
              </button>
            </form>
          </div>
        )}

        {stationTeams.length > 0 && (
          <div className="card p-4 space-y-3">
            <div>
              <h2 className="font-display text-lg font-bold text-foreground">Set Shift by Team</h2>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                Apply one schedule to a whole team across a date range in one go — same
                effect as editing every day&apos;s cell for that team by hand.
              </p>
            </div>
            <form action={setTeamScheduleRange} className="space-y-3">
              <input type="hidden" name="station" value={station} />
              <input type="hidden" name="week" value={weekStart} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Team</label>
                  <select name="team" required className="input-base">
                    {stationTeams.map((t) => (
                      <option key={t.team} value={t.team}>
                        {t.team}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">Schedule</label>
                  <select name="shift_code" required className="input-base" defaultValue="">
                    <option value="" disabled>
                      Pick a schedule…
                    </option>
                    {shifts.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">From</label>
                  <input type="date" name="date_from" defaultValue={weekStart} required className="input-base" />
                </div>
                <div>
                  <label className="field-label">To</label>
                  <input type="date" name="date_to" defaultValue={weekEnd} required className="input-base" />
                </div>
              </div>
              <input type="text" name="notes" placeholder="Notes (optional)" className="input-base" />
              <button type="submit" className="btn-primary">
                Apply to team
              </button>
            </form>
          </div>
        )}

        <div className="card p-4 space-y-4">
          <div>
            <h2 className="font-display text-lg font-bold text-foreground">Create Schedule</h2>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              Build a named schedule with its own timing — it shows up as an option in
              every roster cell above as soon as you save it.
            </p>
          </div>

          <CreateScheduleForm />

          {shifts.length > 0 && (
            <div className="pt-3 border-t border-border">
              <p className="field-label mb-2">Saved schedules</p>
              <div className="divide-y divide-border">
                {shifts.map((s) => (
                  <div key={s.code} className="flex items-center justify-between py-2 gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ background: s.color_hex ?? "var(--cyan)" }}
                      />
                      <div className="min-w-0">
                        <p className="font-semibold text-xs text-foreground truncate">
                          {s.label}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {s.default_start && s.default_end
                            ? `${s.default_start.slice(0, 5)}–${s.default_end.slice(0, 5)}`
                            : "No shift timing"}
                        </p>
                      </div>
                    </div>
                    {s.code === "OFF" ? (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground shrink-0">
                        PROTECTED
                      </span>
                    ) : (
                      <form action={deleteShift}>
                        <input type="hidden" name="code" value={s.code} />
                        <button
                          type="submit"
                          className="font-mono text-[10px] font-semibold text-destructive hover:underline shrink-0"
                        >
                          Delete
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
