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
  const profile = await requireRole(ENFORCEMENT_SEARCH_ROLES);
  const flight = (searchParams.flight || "").trim();
  const date = searchParams.date || "";

  const search = flight ? await searchFlightAttendance(flight, date || undefined) : null;

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-[13px]" style={{ color: "var(--soft)" }}>
          Search flight attendance by flight number, optionally narrowed to one date. Covers
          SEC016, SEC029, and Offload records — the only report types that carry a flight
          number. Every search here is logged for audit.
        </p>

        <form method="get" className="space-y-2.5">
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <input
              type="text"
              name="flight"
              defaultValue={flight}
              placeholder="e.g. AK122"
              autoCapitalize="characters"
              className="input-base t-mono"
            />
            <input type="date" name="date" defaultValue={date} className="input-base" />
          </div>
          <button type="submit" className="btn-primary w-full">
            Search
          </button>
        </form>

        {search && !search.ok && <div className="disclaimer-band">{search.error}</div>}

        {search?.ok && (
          <div className="space-y-2">
            <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
              {search.results.length} result{search.results.length === 1 ? "" : "s"}
            </p>
            {search.results.length === 0 && (
              <div className="disclaimer-band">No flight attendance records found.</div>
            )}
            {search.results.map((r) => (
              <Link
                key={`${r.report_type}-${r.report_id}`}
                href={`/avsec/reports/view/${r.report_type}/${r.report_id}`}
                className="card p-4 flex items-center justify-between gap-3 block"
              >
                <div className="min-w-0">
                  <p className="t-mono text-[11px] font-bold" style={{ color: "var(--gold)" }}>
                    {r.flight_no} · {r.aircraft_registration || "—"}
                  </p>
                  <p className="font-semibold text-[13px] mt-1" style={{ color: "var(--ink2)" }}>
                    {REPORT_META[r.report_type].name}
                  </p>
                  <p className="t-mono text-[10.5px] mt-1" style={{ color: "var(--soft)" }}>
                    {r.staff_name} · {r.station} · {r.team}
                    {r.location_detail ? ` · ${r.location_detail}` : ""}
                  </p>
                </div>
                <span className="t-mono text-[9.5px] shrink-0 text-right" style={{ color: "var(--faint)" }}>
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
