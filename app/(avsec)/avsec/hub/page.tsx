import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { createClient } from "@/lib/supabase/server";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";

/**
 * Hub SE: the stations of the ASSIGNED hub only, with a station selector, today's staffing, rostered teams, open Bay Board aircraft and
 * the reports this Hub SE is authorized to see. Scanner / receipt actions appear only when the station-capability table grants them to
 * the caller (a Hub SE holds no station assignment, so they stay off). No other hub is ever listed or openable.
 */
export default async function HubOverviewPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await requireProfile();
  if (!(profile.canonical as CanonicalAccess).roleCodes.includes("hub_se")) redirect("/avsec/my-dashboard");
  const params = await searchParamsPromise;
  const supabase = await createClient();
  const { data: stations, error: stationError } = await supabase.rpc("list_hub_stations_secure");
  if (stationError || !stations) {
    return (
      <main className="min-h-screen pb-24">
        <p className="m-6 font-mono text-xs text-destructive" role="alert">
          Your hub could not be loaded right now.
        </p>
      </main>
    );
  }
  const hubName = stations[0]?.hub_name ?? "your hub";
  const selected = stations.some((s) => s.station_code === params.station) ? (params.station as string) : null;
  const { data: overview, error } = await supabase.rpc("get_hub_station_overview_secure", { p_station_code: selected, p_date: null });

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">Hub SE — {hubName}</h1>
          <p className="font-mono text-xs text-muted-foreground">Only the stations of your assigned hub are shown.</p>
        </header>
        <form method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Station selector">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Station</span>
            <select name="station" defaultValue={selected ?? ""} className="input-base min-w-[12rem]">
              <option value="">All stations in {hubName}</option>
              {stations.map((s) => (
                <option key={s.station_code} value={s.station_code}>
                  {s.station_code} — {s.station_name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">Show</button>
          <Link href="/avsec/hub" className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">Reset</Link>
        </form>
        {error && (
          <p className="font-mono text-xs text-destructive" role="alert">
            The overview could not be loaded right now.
          </p>
        )}
        {!error && (overview ?? []).length === 0 && (
          <p className="card p-6 text-center font-mono text-xs text-muted-foreground" role="status">
            No stations to show.
          </p>
        )}
        {(overview ?? []).map((o) => (
          <DashboardCard key={o.station_code} title={`Station ${o.station_code}`} status="ok">
            <div className="flex flex-wrap gap-2">
              <StatTile label="Rostered teams today" value={Number(o.rostered_teams)} />
              <StatTile label="Checked in" value={Number(o.checked_in)} />
              <StatTile label="Pending" value={Number(o.pending)} />
              <StatTile label="Absent" value={Number(o.absent)} />
              <StatTile label="Aircraft on ground" value={Number(o.open_bay_board)} />
              <StatTile label="Reports (7 days)" value={Number(o.reports_last_7_days)} />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              Station capability — scanner: {o.can_scan ? "permitted" : "not permitted"} · final receipt: {o.can_confirm_receipt ? "permitted" : "not permitted"} (informational: a Hub SE holds no station assignment, so no scanner or receipt action is offered)
            </p>
          </DashboardCard>
        ))}
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/avsec/admin/roster" className="rounded-lg border border-border/60 px-3 py-3 min-h-[44px]">Roster</Link>
          <Link href="/avsec/reports/lookup" className="rounded-lg border border-border/60 px-3 py-3 min-h-[44px]">Report search</Link>
          <Link href="/avsec/bay-board" className="rounded-lg border border-border/60 px-3 py-3 min-h-[44px]">Bay Board</Link>
        </div>
      </div>
    </main>
  );
}
