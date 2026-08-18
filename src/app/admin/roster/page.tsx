import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { STATIONS } from "@/lib/reference-data";
import {
  getShifts,
  getRosterOfficers,
  getRosterWeek,
  getStationTeams,
  type RosterCell as RosterCellRow,
} from "@/lib/duty/roster-queries";
import { addStationTeam, setTeamScheduleRange, deleteShift } from "@/lib/duty/roster-actions";
import { getZonesForStation } from "@/lib/duty/zone-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { RosterCell } from "@/components/admin/RosterCell";
import { CreateScheduleForm } from "@/components/admin/CreateScheduleForm";
import { todayISODateMY } from "@/lib/datetime";
import { initials } from "@/lib/utils";

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
  searchParams,
}: {
  searchParams: { station?: string; week?: string; q?: string; page?: string; error?: string };
}) {
  const profile = await requireRole(ADMIN_ROLES);

  const station = searchParams.station || profile.station || STATIONS[0];
  const weekStart = mondayOf(searchParams.week || todayISODateMY());
  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = todayISODateMY();
  const search = searchParams.q || "";
  const page = Math.max(1, Number(searchParams.page) || 1);

  const [shifts, officers, rosterRows, stationTeams, zones] = await Promise.all([
    getShifts(),
    getRosterOfficers(station, search),
    getRosterWeek(station, weekStart, weekEnd),
    getStationTeams(station),
    getZonesForStation(station),
  ]);

  const cellMap = new Map<string, RosterCellRow>();
  for (const row of rosterRows) cellMap.set(`${row.team}|${row.roster_date}`, row);

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
      <AppHeader profile={profile} title="Team Roster" backHref="/admin/users" />
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="t-display text-xl">Team Roster</h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--soft)" }}>
            Admin-entered, day by day. One row per officer for easy scanning — but a cell
            still sets the shift for that officer&apos;s <strong>whole team</strong>, exactly
            as before. Editing any officer&apos;s cell updates everyone on their team for that day.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

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
            <Link href={`/admin/roster?${qs({ week: prevWeek, page: "1" })}`} className="btn-quiet">
              ← Prev week
            </Link>
            <span className="t-mono text-[11px]" style={{ color: "var(--soft)" }}>
              {dayLabel(weekStart)} – {dayLabel(weekEnd)}
            </span>
            <Link href={`/admin/roster?${qs({ week: today, page: "1" })}`} className="btn-quiet">
              Today
            </Link>
            <Link href={`/admin/roster?${qs({ week: nextWeek, page: "1" })}`} className="btn-quiet">
              Next week →
            </Link>
          </div>
        </div>

        {officers.length === 0 ? (
          <div className="card p-5 space-y-3">
            <p className="text-sm" style={{ color: "var(--soft)" }}>
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
                <tr>
                  <th className="text-left p-2 t-mono text-[10px]" style={{ color: "var(--faint)" }}>
                    Officer
                  </th>
                  {days.map((date) => (
                    <th
                      key={date}
                      className="text-left p-2 t-mono text-[10px]"
                      style={{ color: date === today ? "var(--red)" : "var(--gold)" }}
                    >
                      {dayLabel(date)}
                      {date === today && (
                        <span
                          className="block w-1.5 h-1.5 rounded-full mt-1"
                          style={{ background: "var(--red)" }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageOfficers.map((o) => (
                  <tr key={o.id} style={{ borderTop: "1px solid var(--line2)" }}>
                    <td className="p-2 align-top whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center t-mono text-[9.5px] font-bold"
                          style={{ background: "var(--gold-fill)", color: "var(--on-gold)" }}
                        >
                          {initials(o.name)}
                        </span>
                        <div>
                          <p className="font-semibold text-[12.5px]" style={{ color: "var(--ink2)" }}>
                            {o.name}
                          </p>
                          <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
                            {o.staff_no} · {o.team || "—"}
                          </p>
                        </div>
                      </div>
                    </td>
                    {days.map((date) => (
                      <td key={date} className="p-1 align-top min-w-[140px]">
                        {o.team ? (
                          <RosterCell
                            station={station}
                            team={o.team}
                            date={date}
                            week={weekStart}
                            shifts={shifts}
                            zones={zones}
                            cell={cellMap.get(`${o.team}|${date}`)}
                          />
                        ) : (
                          <p className="t-mono text-[9.5px] p-2" style={{ color: "var(--faintest)" }}>
                            No team set
                          </p>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4" style={{ borderTop: "1px solid var(--line2)" }}>
                <span className="t-mono text-[10.5px]" style={{ color: "var(--soft)" }}>
                  {officers.length} officers · page {page} / {totalPages}
                </span>
                <div className="flex gap-2">
                  {page > 1 && (
                    <Link href={`/admin/roster?${qs({ page: String(page - 1) })}`} className="btn-quiet">
                      ← Prev
                    </Link>
                  )}
                  {page < totalPages && (
                    <Link href={`/admin/roster?${qs({ page: String(page + 1) })}`} className="btn-quiet">
                      Next →
                    </Link>
                  )}
                </div>
              </div>
            )}

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

        {stationTeams.length > 0 && (
          <div className="card p-4 space-y-3">
            <div>
              <h2 className="t-display text-lg">Set Shift by Team</h2>
              <p className="text-[12.5px] mt-1" style={{ color: "var(--soft)" }}>
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
              <div>
                <label className="field-label">Zone (leave blank for unrestricted check-in/out)</label>
                <select name="zone_id" defaultValue="" className="input-base">
                  <option value="">No zone — unrestricted</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
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
            <h2 className="t-display text-lg">Create Schedule</h2>
            <p className="text-[12.5px] mt-1" style={{ color: "var(--soft)" }}>
              Build a named schedule with its own timing — it shows up as an option in
              every roster cell above as soon as you save it.
            </p>
          </div>

          <CreateScheduleForm />

          {shifts.length > 0 && (
            <div className="pt-3" style={{ borderTop: "1px solid var(--line2)" }}>
              <p className="field-label mb-2">Saved schedules</p>
              <div className="divide-y" style={{ borderColor: "var(--line2)" }}>
                {shifts.map((s) => (
                  <div key={s.code} className="flex items-center justify-between py-2 gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ background: s.color_hex ?? "var(--faint)" }}
                      />
                      <div className="min-w-0">
                        <p className="font-semibold text-[13px] truncate" style={{ color: "var(--ink2)" }}>
                          {s.label}
                        </p>
                        <p className="t-mono text-[10px]" style={{ color: "var(--faint)" }}>
                          {s.default_start && s.default_end
                            ? `${s.default_start.slice(0, 5)}–${s.default_end.slice(0, 5)}`
                            : "No shift timing"}
                        </p>
                      </div>
                    </div>
                    {s.code === "OFF" ? (
                      <span className="t-mono text-[9px] shrink-0" style={{ color: "var(--faintest)" }}>
                        PROTECTED
                      </span>
                    ) : (
                      <form action={deleteShift}>
                        <input type="hidden" name="code" value={s.code} />
                        <button
                          type="submit"
                          className="t-mono text-[9.5px] font-semibold shrink-0"
                          style={{ color: "var(--red)" }}
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
