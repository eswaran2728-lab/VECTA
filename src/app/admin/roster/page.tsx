import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { STATIONS } from "@/lib/reference-data";
import { getShifts, getStationTeams, getRosterWeek, type RosterCell as RosterCellRow } from "@/lib/duty/roster-queries";
import { addStationTeam } from "@/lib/duty/roster-actions";
import { AppHeader } from "@/components/layout/AppHeader";
import { RosterCell } from "@/components/admin/RosterCell";
import { todayISODateMY } from "@/lib/datetime";

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
  searchParams,
}: {
  searchParams: { station?: string; week?: string; error?: string };
}) {
  const profile = await requireRole(ADMIN_ROLES);

  const station = searchParams.station || profile.station || STATIONS[0];
  const weekStart = mondayOf(searchParams.week || todayISODateMY());
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const [shifts, stationTeams, rosterRows] = await Promise.all([
    getShifts(),
    getStationTeams(station),
    getRosterWeek(station, weekStart, weekEnd),
  ]);

  const cellMap = new Map<string, RosterCellRow>();
  for (const row of rosterRows) cellMap.set(`${row.team}|${row.roster_date}`, row);

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Team Roster" backHref="/admin/users" />
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="t-display text-xl">Team Roster</h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--soft)" }}>
            Admin-entered, day by day — nothing here is auto-generated. Edits apply to that
            station&apos;s own teams only.
          </p>
        </div>

        {searchParams.error && (
          <div className="disclaimer-band">{searchParams.error}</div>
        )}

        <div className="card p-4 flex flex-wrap items-end gap-3">
          <form method="get" className="flex items-end gap-3">
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
            <input type="hidden" name="week" value={weekStart} />
            <button type="submit" className="btn-secondary">
              Switch
            </button>
          </form>

          <div className="flex items-center gap-2 ml-auto">
            <Link
              href={`/admin/roster?station=${encodeURIComponent(station)}&week=${prevWeek}`}
              className="btn-quiet"
            >
              ← Prev week
            </Link>
            <span className="t-mono text-[11px]" style={{ color: "var(--soft)" }}>
              {dayLabel(weekStart)} – {dayLabel(weekEnd)}
            </span>
            <Link
              href={`/admin/roster?station=${encodeURIComponent(station)}&week=${nextWeek}`}
              className="btn-quiet"
            >
              Next week →
            </Link>
          </div>
        </div>

        {stationTeams.length === 0 ? (
          <div className="card p-5 space-y-3">
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              No teams defined yet for <strong>{station}</strong>. Add a team to start building
              its roster.
            </p>
            <form action={addStationTeam} className="flex gap-2">
              <input type="hidden" name="station" value={station} />
              <input
                type="text"
                name="team"
                placeholder="e.g. ALPHA"
                required
                className="input-base flex-1"
              />
              <button type="submit" className="btn-primary">
                Add team
              </button>
            </form>
          </div>
        ) : (
          <div className="card p-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr>
                  <th className="text-left p-2 t-mono text-[10px]" style={{ color: "var(--faint)" }}>
                    Date
                  </th>
                  {stationTeams.map((t) => (
                    <th key={t.team} className="text-left p-2 t-mono text-[10px]" style={{ color: "var(--gold)" }}>
                      {t.team}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map((date) => (
                  <tr key={date} style={{ borderTop: "1px solid var(--line2)" }}>
                    <td className="p-2 t-mono text-[11px] align-top whitespace-nowrap" style={{ color: "var(--ink2)" }}>
                      {dayLabel(date)}
                    </td>
                    {stationTeams.map((t) => (
                      <td key={t.team} className="p-1 align-top min-w-[140px]">
                        <RosterCell
                          station={station}
                          team={t.team}
                          date={date}
                          week={weekStart}
                          shifts={shifts}
                          cell={cellMap.get(`${t.team}|${date}`)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <form action={addStationTeam} className="flex gap-2 mt-4 pt-4" style={{ borderTop: "1px solid var(--line2)" }}>
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
      </div>
    </main>
  );
}
