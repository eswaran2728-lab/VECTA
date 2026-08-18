import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { STATIONS, ORG_WIDE_ROLES, type UserRole } from "@/lib/reference-data";
import { getDutyMonitorRows, type DutyMonitorRow } from "@/lib/duty/monitor-queries";
import { getStationTeams } from "@/lib/duty/roster-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { todayISODateMY, formatTimeMY } from "@/lib/datetime";

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
  searchParams,
}: {
  searchParams: { station?: string; team?: string; date?: string };
}) {
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
      <AppHeader profile={profile} title="Check-In Monitoring" backHref="/dashboard" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="grid grid-cols-4 gap-2">
          <div className="card p-3 text-center">
            <p className="text-xl font-bold" style={{ color: "var(--green)" }}>
              {checkedIn}
            </p>
            <p className="t-mono text-[8.5px] mt-1" style={{ color: "var(--soft)" }}>
              ON DUTY
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="text-xl font-bold" style={{ color: "var(--red)" }}>
              {late}
            </p>
            <p className="t-mono text-[8.5px] mt-1" style={{ color: "var(--soft)" }}>
              LATE
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="text-xl font-bold" style={{ color: "var(--red)" }}>
              {earlyOut}
            </p>
            <p className="t-mono text-[8.5px] mt-1" style={{ color: "var(--soft)" }}>
              EARLY-OUT
            </p>
          </div>
          <div className="card p-3 text-center">
            <p className="text-xl font-bold" style={{ color: "var(--red)" }}>
              {missed}
            </p>
            <p className="t-mono text-[8.5px] mt-1" style={{ color: "var(--soft)" }}>
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
          <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
            {rows.length} staff · {date === today ? "Today" : date}
          </p>
          <Link href="/dashboard/heatmap" className="t-mono text-[10px]" style={{ color: "var(--gold)" }}>
            View on map →
          </Link>
        </div>

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              No ASO/SO/DSE staff found for these filters.
            </p>
          )}
          {rows.map((r) => {
            const color = STATUS_COLOR[r.status];
            const flagged = r.lateMinutes > 0 || r.earlyOutMinutes > 0;
            return (
              <div key={r.profileId} className="card p-4" style={{ borderLeft: `3px solid ${color}` }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                      {r.name}
                    </p>
                    <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
                      {r.role} · {r.team || "—"}
                      {r.shiftCode ? ` · ${r.shiftCode}` : ""}
                      {r.scheduledStart && r.scheduledEnd
                        ? ` · ${r.scheduledStart.slice(0, 5)}–${r.scheduledEnd.slice(0, 5)}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className="t-mono text-[8.5px] font-bold px-2 py-1 shrink-0"
                    style={{ letterSpacing: "0.06em", color, border: `1px solid ${color}` }}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </div>

                {(r.checkInAt || r.checkOutAt) && (
                  <p className="text-[12px] mt-2" style={{ color: "var(--ink2)" }}>
                    {r.checkInAt ? `In ${formatTimeMY(r.checkInAt)}` : "—"}
                    {r.checkInInsideFence === false && (
                      <span className="t-mono text-[9px] ml-1.5" style={{ color: "var(--red)" }}>
                        OUT OF FENCE
                      </span>
                    )}
                    {" · "}
                    {r.checkOutAt ? `Out ${formatTimeMY(r.checkOutAt)}` : r.checkInAt ? "still on duty" : "—"}
                  </p>
                )}

                {flagged && (
                  <details className="mt-2">
                    <summary
                      className="cursor-pointer t-mono text-[9px] font-semibold"
                      style={{ color: "var(--red)" }}
                    >
                      {r.lateMinutes > 0 ? `LATE ${r.lateMinutes} MIN` : ""}
                      {r.lateMinutes > 0 && r.earlyOutMinutes > 0 ? " · " : ""}
                      {r.earlyOutMinutes > 0 ? `EARLY-OUT ${r.earlyOutMinutes} MIN` : ""} — tap for remark
                    </summary>
                    <div className="mt-1.5 space-y-1 text-[11.5px]" style={{ color: "var(--soft)" }}>
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
      <BottomNav profile={profile} />
    </main>
  );
}
