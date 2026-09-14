import Link from "next/link";
import { requireRole, MONITOR_ROLES } from "@/lib/avsec/auth";
import { STATIONS } from "@/lib/avsec/reference-data";
import { getFlightsForDate } from "@/lib/dashboard/flight-detail";
import { todayISODateMY } from "@/lib/avsec/datetime";

export default async function FlightsPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ date?: string; station?: string; flightNo?: string; flightDate?: string; reg?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(MONITOR_ROLES);

  const today = todayISODateMY();
  const date = searchParams.date || today;
  const station = searchParams.station || (profile.station ?? "");

  const flights = await getFlightsForDate(date, station || undefined);

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="font-display font-bold text-2xl text-foreground">Flight Records</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Aggregated view of every record tied to a flight — SEC016, SEC029 search status,
            CaterLink movements, and incidents. Read-only.
          </p>
        </div>

        {/* Lookup by flight number + date */}
        <form method="get" action="/avsec/flights/detail" className="card p-4 space-y-3">
          <h2 className="section-title">Look up by Flight Number</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <div className="col-span-2 sm:col-span-1">
              <label className="field-label">Flight No</label>
              <input type="text" name="flight" placeholder="e.g. AK703" className="input-base" required />
            </div>
            <div>
              <label className="field-label">Date</label>
              <input type="date" name="date" defaultValue={date} className="input-base" required />
            </div>
            <div>
              <label className="field-label">Station</label>
              <select name="station" defaultValue={station} className="input-base" required>
                <option value="">Select…</option>
                {STATIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-primary">
              Open
            </button>
          </div>
        </form>

        {/* Lookup by aircraft registration */}
        <form method="get" action="/avsec/flights/registration" className="card p-4 space-y-3">
          <h2 className="section-title">Look up by Aircraft Registration</h2>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="field-label">Registration</label>
              <input type="text" name="reg" placeholder="e.g. 9M-XYZ" className="input-base" required />
            </div>
            <button type="submit" className="btn-primary">
              Search
            </button>
          </div>
        </form>

        {/* Date-filtered browsable list */}
        <form method="get" className="card p-4 grid grid-cols-2 gap-3 items-end">
          <div>
            <label className="field-label">Date</label>
            <input type="date" name="date" defaultValue={date} className="input-base" />
          </div>
          <div>
            <label className="field-label">Station</label>
            <select name="station" defaultValue={station} className="input-base">
              <option value="">All</option>
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-primary col-span-2">
            Browse Flights
          </button>
        </form>

        <section>
          <h2 className="section-title mb-3">
            Flights on {date}
            {station ? ` · ${station}` : ""} ({flights.length})
          </h2>
          <div className="divide-y divide-border">
            {flights.map((f) => (
              <Link
                key={`${f.flight}-${f.station}`}
                href={`/avsec/flights/detail?flight=${encodeURIComponent(f.flight)}&date=${date}&station=${encodeURIComponent(f.station)}`}
                className="flex items-center justify-between py-3 hover:bg-card/40 group"
              >
                <div>
                  <p className="font-semibold text-foreground group-hover:text-primary transition-colors">{f.flight}</p>
                  <p className="font-mono text-xs text-muted-foreground">{f.station}{f.regNo ? ` · ${f.regNo}` : ""}</p>
                </div>
                <span className="font-mono text-xs text-primary">View →</span>
              </Link>
            ))}
            {flights.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground py-4">No flights recorded on this date.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
