import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { STATIONS, ORG_WIDE_ROLES, type UserRole } from "@/lib/avsec/reference-data";
import { getLiveDutyPoints, getHistoryDutyPoints, getRostersForRange, type DutyPoint } from "@/lib/avsec/duty/heatmap-queries";
import { getZonesForStation } from "@/lib/avsec/duty/zone-queries";
import { getStationTeams, getShifts } from "@/lib/avsec/duty/roster-queries";
import { scheduledWindow } from "@/lib/avsec/duty/lateness";
import { calcOtHours } from "@/lib/avsec/duty/overtime";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { BottomNav } from "@/components/avsec/layout/BottomNav";
import HeatMapLoader from "@/components/avsec/duty/HeatMapLoader";
import { LiveRefresher } from "@/components/avsec/duty/LiveRefresher";
import { todayISODateMY, formatTimeMY } from "@/lib/avsec/datetime";
import type { DutyZone } from "@/lib/avsec/duty/types";

interface ZoneTotal {
  zoneId: string;
  zoneName: string;
  people: DutyPoint[];
  lateCount: number;
  earlyOutCount: number;
  otHours: number;
}

function buildZoneTotals(
  points: DutyPoint[],
  zones: DutyZone[],
  rosterMap: Map<string, { start_time: string | null; end_time: string | null }>,
): ZoneTotal[] {
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const groups = new Map<string, DutyPoint[]>();
  for (const p of points) {
    const key = p.zone_id ?? "unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const totals: ZoneTotal[] = [];
  for (const [key, people] of groups) {
    const zone = key === "unassigned" ? null : (zoneById.get(key) ?? null);
    let otHours = 0;
    for (const p of people) {
      if (!p.check_out_at || !p.team) continue;
      const roster = rosterMap.get(`${p.team}|${p.duty_date}`);
      if (!roster?.start_time || !roster?.end_time) continue;
      const { end } = scheduledWindow(p.duty_date, roster.start_time, roster.end_time);
      otHours += calcOtHours(end, new Date(p.check_out_at));
    }
    totals.push({
      zoneId: key,
      zoneName: zone?.name ?? "Unassigned",
      people,
      lateCount: people.filter((p) => p.late_minutes > 0).length,
      earlyOutCount: people.filter((p) => p.early_out_minutes > 0).length,
      otHours,
    });
  }
  return totals.sort((a, b) => b.people.length - a.people.length);
}

export default async function HeatmapPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{
    mode?: string;
    station?: string;
    team?: string;
    shift?: string;
    zone?: string;
    view?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole([...ORG_WIDE_ROLES] as UserRole[]);

  const mode = searchParams.mode === "history" ? "history" : "live";
  const view = searchParams.view === "pins" ? "pins" : "heat";
  const station = searchParams.station || profile.station || STATIONS[0];
  const today = todayISODateMY();
  const from = searchParams.from || today;
  const to = searchParams.to || today;

  const filters = { team: searchParams.team, shift: searchParams.shift, zone: searchParams.zone };

  const [zones, stationTeams, shifts, points, rosters] = await Promise.all([
    getZonesForStation(station),
    getStationTeams(station),
    getShifts(),
    mode === "live"
      ? getLiveDutyPoints(station, filters)
      : getHistoryDutyPoints(station, from, to, filters),
    mode === "history" ? getRostersForRange(station, from, to) : Promise.resolve([]),
  ]);

  const rosterMap = new Map(rosters.map((r) => [`${r.team}|${r.roster_date}`, r]));
  const zoneTotals = buildZoneTotals(points, zones, rosterMap);
  const mapPoints = points
    .filter((p): p is DutyPoint & { lat: number; lng: number } => p.lat !== null && p.lng !== null)
    .map((p) => ({
      lat: p.lat,
      lng: p.lng,
      label:
        mode === "live"
          ? `${p.name} — on duty since ${formatTimeMY(p.check_in_at)}`
          : `${p.name} — ${formatTimeMY(p.check_in_at)}${p.check_out_at ? ` → ${formatTimeMY(p.check_out_at)}` : ""}`,
    }));

  const qs = (overrides: Record<string, string | undefined>) => {
    const params = new URLSearchParams({
      mode,
      station,
      view,
      from,
      to,
      ...(searchParams.team ? { team: searchParams.team } : {}),
      ...(searchParams.shift ? { shift: searchParams.shift } : {}),
      ...(searchParams.zone ? { zone: searchParams.zone } : {}),
    });
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) params.delete(k);
      else params.set(k, v);
    }
    return `/dashboard/heatmap?${params.toString()}`;
  };

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Duty Heat Map" backHref="/avsec/dashboard" />
      {mode === "live" && <LiveRefresher />}
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex gap-1.5">
          <Link
            href={qs({ mode: "live" })}
            className="t-mono text-[10px] font-semibold px-3 py-2"
            style={{
              letterSpacing: "0.1em",
              border: `1px solid ${mode === "live" ? "var(--gold-fill)" : "var(--line3)"}`,
              background: mode === "live" ? "var(--gold-soft)" : "transparent",
              color: mode === "live" ? "var(--gold)" : "var(--mid)",
            }}
          >
            LIVE
          </Link>
          <Link
            href={qs({ mode: "history" })}
            className="t-mono text-[10px] font-semibold px-3 py-2"
            style={{
              letterSpacing: "0.1em",
              border: `1px solid ${mode === "history" ? "var(--gold-fill)" : "var(--line3)"}`,
              background: mode === "history" ? "var(--gold-soft)" : "transparent",
              color: mode === "history" ? "var(--gold)" : "var(--mid)",
            }}
          >
            HISTORY
          </Link>
        </div>

        <form method="get" className="card p-4 space-y-3">
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="view" value={view} />
          <div className="grid grid-cols-2 gap-3">
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
              <label className="field-label">Shift</label>
              <select name="shift" defaultValue={searchParams.shift ?? ""} className="input-base">
                <option value="">All shifts</option>
                {shifts.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">Zone</label>
              <select name="zone" defaultValue={searchParams.zone ?? ""} className="input-base">
                <option value="">All zones</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {mode === "history" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">From</label>
                <input type="date" name="from" defaultValue={from} className="input-base" />
              </div>
              <div>
                <label className="field-label">To</label>
                <input type="date" name="to" defaultValue={to} className="input-base" />
              </div>
            </div>
          )}

          <button type="submit" className="btn-secondary">
            Apply filters
          </button>
        </form>

        <div className="flex items-center justify-between">
          <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
            {mode === "live" ? `${points.length} currently on duty` : `${points.length} records · ${from} – ${to}`}
          </p>
          <div className="flex gap-1.5">
            <Link
              href={qs({ view: "heat" })}
              className="t-mono text-[9px] font-semibold px-2 py-1"
              style={{
                border: `1px solid ${view === "heat" ? "var(--gold-fill)" : "var(--line3)"}`,
                color: view === "heat" ? "var(--gold)" : "var(--mid)",
              }}
            >
              HEAT
            </Link>
            <Link
              href={qs({ view: "pins" })}
              className="t-mono text-[9px] font-semibold px-2 py-1"
              style={{
                border: `1px solid ${view === "pins" ? "var(--gold-fill)" : "var(--line3)"}`,
                color: view === "pins" ? "var(--gold)" : "var(--mid)",
              }}
            >
              PINS
            </Link>
          </div>
        </div>

        <div className="card overflow-hidden">
          <HeatMapLoader points={mapPoints} zones={zones} view={view} />
        </div>

        <div className="space-y-2">
          {zoneTotals.length === 0 && (
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              {mode === "live" ? "No one currently checked in for these filters." : "No duty records in this range."}
            </p>
          )}
          {zoneTotals.map((zt) => (
            <details key={zt.zoneId} className="card p-4">
              <summary className="flex items-center justify-between cursor-pointer list-none">
                <span className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                  {zt.zoneName}
                </span>
                <span className="t-mono text-[10px]" style={{ color: "var(--gold)" }}>
                  {mode === "live" ? `${zt.people.length} on duty` : `${zt.people.length} records`}
                  {zt.lateCount > 0 ? ` · ${zt.lateCount} late` : ""}
                  {zt.earlyOutCount > 0 ? ` · ${zt.earlyOutCount} early-out` : ""}
                  {mode === "history" && zt.otHours > 0 ? ` · ${zt.otHours}h OT` : ""}
                </span>
              </summary>
              <div className="mt-3 space-y-1.5" style={{ borderTop: "1px solid var(--line2)", paddingTop: "10px" }}>
                {zt.people.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-[12.5px]">
                    <span style={{ color: "var(--ink2)" }}>
                      {p.name} {p.team ? `· ${p.team}` : ""}
                    </span>
                    <span className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
                      {formatTimeMY(p.check_in_at)}
                      {p.check_out_at ? ` → ${formatTimeMY(p.check_out_at)}` : mode === "live" ? " → now" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
