import Link from "next/link";
import { requirePhase8Role } from "@/lib/phase8/auth";
import { listPendingSec013AcknowledgementsSecure } from "@/lib/phase8/workforce";
import { ProfilingAcknowledgeControl } from "@/components/avsec/profiling/ProfilingAcknowledgeControl";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function ProfilingWorkspacePage() {
  const { activeRole } = await requirePhase8Role(["profiling_so", "profiling_aso"]);

  const pendingResult = activeRole === "profiling_so" ? await listPendingSec013AcknowledgementsSecure() : { ok: true, error: null, data: [] };
  const pending = pendingResult.data ?? [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold font-display">Staff Profiling Workspace</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {activeRole === "profiling_so"
              ? "Team oversight and SEC013 acknowledgement for your own team."
              : "SEC013 submission and your team's roster/attendance."}{" "}
            Profiling accounts are not authorized for CaterLink scanning.
          </p>
        </div>

        {pendingResult.error && (
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">{pendingResult.error}</div>
        )}

        {activeRole === "profiling_so" && (
          <section className="space-y-2.5">
            <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              SEC013 Reports Awaiting Acknowledgement ({pending.length})
            </h2>
            {pending.length === 0 && (
              <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
                No SEC013 reports pending acknowledgement for your team.
              </div>
            )}
            {pending.map((r) => (
              <div key={r.report_id} className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-foreground">{r.staff_name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.station} · {r.team} · {formatDateTimeMY(r.submitted_at)}
                  </p>
                </div>
                <ProfilingAcknowledgeControl reportId={r.report_id} />
              </div>
            ))}
          </section>
        )}

        <section className="space-y-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Other Duty Functions</h2>
          <Link href="/avsec/duty" className="btn-secondary w-full text-center block">
            Check-In / Check-Out, Roster, Leave & OT →
          </Link>
          {activeRole === "profiling_aso" && (
            <Link href="/avsec/reports/sec013" className="btn-secondary w-full text-center block">
              Submit SEC013 →
            </Link>
          )}
        </section>
      </div>
    </main>
  );
}
