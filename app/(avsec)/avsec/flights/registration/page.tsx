import Link from "next/link";
import { requireRole, MONITOR_ROLES } from "@/lib/avsec/auth";
import { getMovementsByRegistration } from "@/lib/dashboard/flight-detail";

export default async function FlightsByRegistrationPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ reg?: string }>;
}) {
  await requireRole(MONITOR_ROLES);
  const searchParams = await searchParamsPromise;
  const reg = (searchParams.reg || "").trim();

  const movements = reg ? await getMovementsByRegistration(reg) : [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <Link href="/avsec/flights" className="font-mono text-xs text-primary">← Flight Records</Link>
          <h1 className="font-display font-bold text-2xl text-foreground mt-1">
            Aircraft {reg || "—"}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">Recent movements across all flights/days.</p>
        </div>

        <div className="divide-y divide-border">
          {movements.map((m) => (
            <Link
              key={`${m.source}-${m.id}`}
              href={
                m.flight
                  ? `/avsec/flights/detail?flight=${encodeURIComponent(m.flight)}&date=${m.date}&station=${encodeURIComponent(m.station)}`
                  : "#"
              }
              className="flex items-center justify-between py-3 hover:bg-card/40 group"
            >
              <span className="font-semibold text-foreground group-hover:text-primary transition-colors">{m.summary}</span>
              <span className="font-mono text-xs text-muted-foreground">{m.station}</span>
            </Link>
          ))}
          {reg && movements.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground py-4">No movements found for this registration.</p>
          )}
        </div>
      </div>
    </main>
  );
}
