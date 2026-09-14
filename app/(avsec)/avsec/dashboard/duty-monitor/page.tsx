import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { STATIONS, ORG_WIDE_ROLES, type UserRole } from "@/lib/avsec/reference-data";
import { getDutyMonitorRows, type DutyMonitorRow } from "@/lib/avsec/duty/monitor-queries";
import { getStationTeams } from "@/lib/avsec/duty/roster-queries";
import { LiveRefresher } from "@/components/avsec/duty/LiveRefresher";
import { todayISODateMY, formatTimeMY } from "@/lib/avsec/datetime";

const STATUS_LABEL: Record<DutyMonitorRow["status"], string> = {
  checked_in: "ON DUTY",
  checked_out: "COMPLETE",
  off: "OFF",
  no_roster: "NO ROSTER",
  missed: "MISSED",
  pending: "PENDING",
  upcoming: "UPCOMING",
};

const STATUS_COLOR: Record<DutyMonitorRow["status"], string> = {
  checked_in: "var(--green)",
  checked_out: "var(--blue)",
  off: "var(--faint)",
  no_roster: "var(--faintest)",
  missed: "var(--red)",
  pending: "var(--faint)",
  upcoming: "var(--faintest)",
};

export default async function DutyMonitorPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ station?: string; team?: string; date?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole([...ORG_WIDE_ROLES] as UserRole[]);

  const station = searchParams.station || profile.station || STATIONS[0];
  const today = todayISODateMY();
  const date = searchParams.date || today;

  const [rows, stationTeams] = await Promise.all([
    getDutyMonitorRows(station, date, today, searchParams.team),
    getStationTeams(station),
  ]);

  const checkedIn = rows.filter((r) => r.status === "checked_in").length;
  const late = rows.filter((r) => r.lateMinutes > 0).length;
  const earlyOut = rows.filter((r) => r.earlyOutMinutes > 0).length;
  const missed = rows.filter((r) => r.status === "missed").length;

  return (
    <main className="min-h-screen pb-32">
      {date === today && <LiveRefresher />}
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-4 gap-2">
          <div className="card p-3 text-center">
            <p className="font-mono text-xl font-bold text-success">
              {checkedIn}
            </p>
            <p className="font-mono text-[8.5px] uppercase tracking-wider mt-1 text-muted-foreground">
              ON DUTY
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="font-mono text-xl font-bold text-destructive">
              {late}
            </p>
            <p className="font-mono text-[8.5px] uppercase tracking-wider mt-1 text-muted-foreground">
              LATE
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="font-mono text-xl font-bold text-destructive">
              {earlyOut}
            </p>
            <p className="font-mono text-[8.5px] uppercase tracking-wider mt-1 text-muted-foreground">
              EARLY-OUT
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="font-mono text-xl font-bold text-destructive">
              {missed}
            </p>
            <p className="font-mono text-[8.5px] uppercase tracking-wider mt-1 text-muted-foreground">
              MISSED
            </p>
          </div>
        </div>

        <form method="get" className="card p-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
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
              <label className="field-label">Team</label>
              <select name="team" defaultValue={searchParams.team ?? ""} className="input-base">
                <option value="">All teams</option>
                {stationTeams.map((t) => (
                  <option key={t.team} value={t.team}>
                    {t.team}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Date</label>
              <input type="date" name="date" defaultValue={date} className="input-base" />
            </div>
          </div>
          <button type="submit" className="btn-secondary">
            Apply
          </button>
        </form>

        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
            {rows.length} staff · {date === today ? "Today" : date}
            {date === today && (
              <span className="font-mono text-[8.5px] font-bold text-success animate-pulse">
                ● LIVE
              </span>
            )}
          </p>
          <Link href="/avsec/dashboard/heatmap" className="font-mono text-[10px] font-semibold text-primary hover:underline uppercase tracking-wider">
            View on map →
          </Link>
        </div>

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="font-mono text-sm text-muted-foreground text-center py-4">
              No ASO/SO/DSE staff found for these filters.
            </p>
          )}
          {rows.map((r) => {
            const statusTheme = {
              checked_in: "border-l-4 border-l-success border-border bg-card",
              checked_out: "border-l-4 border-l-cyan border-border bg-card",
              off: "border-l-4 border-l-muted-foreground/40 border-border bg-card/60",
              no_roster: "border-l-4 border-l-border border-border bg-card/40",
              missed: "border-l-4 border-l-destructive border-border bg-destructive/5",
              pending: "border-l-4 border-l-muted-foreground/40 border-border bg-card",
              upcoming: "border-l-4 border-l-border border-border bg-card/40",
            }[r.status];

            const pillTheme = {
              checked_in: "border-success/40 bg-success/10 text-success",
              checked_out: "border-cyan/40 bg-cyan/10 text-cyan",
              off: "border-border text-muted-foreground",
              no_roster: "border-border text-muted-foreground/60",
              missed: "border-destructive/40 bg-destructive/10 text-destructive",
              pending: "border-border text-muted-foreground",
              upcoming: "border-border text-muted-foreground/60",
            }[r.status];

            const flagged = r.lateMinutes > 0 || r.earlyOutMinutes > 0;
            return (
              <div key={r.profileId} className={`card p-4 ${statusTheme}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-xs text-foreground">
                      {r.name}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                      {r.role} · {r.team || "—"}
                      {r.shiftCode ? ` · ${r.shiftCode}` : ""}
                      {r.scheduledStart && r.scheduledEnd
                        ? ` · ${r.scheduledStart.slice(0, 5)}–${r.scheduledEnd.slice(0, 5)}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`font-mono text-[8.5px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider shrink-0 ${pillTheme}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>

                {(r.checkInAt || r.checkOutAt) && (
                  <p className="font-mono text-xs text-foreground/90 mt-2">
                    {r.checkInAt ? `In ${formatTimeMY(r.checkInAt)}` : "—"}
                    {r.checkInInsideFence === false && (
                      <span className="font-mono text-[9px] font-bold ml-1.5 text-destructive">
                        OUT OF FENCE
                      </span>
                    )}
                    {" · "}
                    {r.checkOutAt ? `Out ${formatTimeMY(r.checkOutAt)}` : r.checkInAt ? "still on duty" : "—"}
                  </p>
                )}

                {flagged && (
                  <details className="mt-2 border-t border-border/40 pt-1.5">
                    <summary
                      className="cursor-pointer font-mono text-[9px] font-semibold text-destructive uppercase tracking-wider"
                    >
                      {r.lateMinutes > 0 ? `LATE ${r.lateMinutes} MIN` : ""}
                      {r.lateMinutes > 0 && r.earlyOutMinutes > 0 ? " · " : ""}
                      {r.earlyOutMinutes > 0 ? `EARLY-OUT ${r.earlyOutMinutes} MIN` : ""} — tap for remark
                    </summary>
                    <div className="mt-1.5 space-y-1 font-mono text-xs text-muted-foreground">
                      {r.lateMinutes > 0 && <p>{r.lateRemark}</p>}
                      {r.earlyOutMinutes > 0 && <p>{r.earlyOutRemark}</p>}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
