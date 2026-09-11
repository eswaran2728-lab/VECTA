import Link from "next/link";
import { requireRole, ENFORCEMENT_SEARCH_ROLES } from "@/lib/avsec/auth";
import { searchFlightAttendance } from "@/lib/avsec/search/enforcementSearch";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function EnforcementSearchPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ flight?: string; date?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  await requireRole(ENFORCEMENT_SEARCH_ROLES);
  const flight = (searchParams.flight || "").trim();
  const date = searchParams.date || "";

  const search = flight ? await searchFlightAttendance(flight, date || undefined) : null;

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Flight Attendance Search</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Search flight attendance by flight number, optionally narrowed to one date. Covers
            SEC016, SEC029, and Offload records. Every search is logged for audit.
          </p>
        </div>

        <form method="get" className="space-y-2.5">
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <input
              type="text"
              name="flight"
              defaultValue={flight}
              placeholder="e.g. AK122"
              autoCapitalize="characters"
              className="input-base font-mono text-xs"
            />
            <input type="date" name="date" defaultValue={date} className="input-base text-xs" />
          </div>
          <button type="submit" className="btn-primary w-full text-xs">
            Search Attendance
          </button>
        </form>

        {search && !search.ok && (
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">
            {search.error}
          </div>
        )}

        {search?.ok && (
          <div className="space-y-2.5 pt-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {search.results.length} result{search.results.length === 1 ? "" : "s"} found
            </p>
            {search.results.length === 0 && (
              <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
                No flight attendance records found for &quot;{flight}&quot;.
              </div>
            )}
            {search.results.map((r) => (
              <Link
                key={`${r.report_type}-${r.report_id}`}
                href={`/avsec/reports/view/${r.report_type}/${r.report_id}`}
                className="card p-4 flex items-center justify-between gap-3 border-border/80 bg-surface/80 hover:border-primary/60 transition-all block"
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-mono text-xs font-bold text-primary">
                    {r.flight_no} · {r.aircraft_registration || "—"}
                  </p>
                  <p className="font-semibold text-sm text-foreground">
                    {REPORT_META[r.report_type].name}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.staff_name} · {r.station} · {r.team}
                    {r.location_detail ? ` · ${r.location_detail}` : ""}
                  </p>
                </div>
                <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">
                  {r.flight_date ? formatDateMY(r.flight_date) : formatDateTimeMY(r.submitted_at)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
