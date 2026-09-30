import { requirePhase8Role } from "@/lib/phase8/auth";
import { listSatCombinedReportsForViewer } from "@/lib/phase8/sat";
import { SatReportUploadForm, SatReportReplaceForm } from "@/components/avsec/sat/SatReportForms";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function SatCombinedReportsPage() {
  const { activeRole } = await requirePhase8Role(["sat_aso", "main_enforcement", "investigation_sso", "investigation_so", "investigation_aso"]);
  const canUpload = activeRole === "sat_aso";

  const result = await listSatCombinedReportsForViewer();
  const reports = result.data ?? [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold font-display">SAT Combined Daily Reports</h1>
          <p className="text-xs text-muted-foreground mt-1">
            One combined PDF per team per operational date (up to 4 per day, KUL Alpha/Bravo/Charlie/Delta).
            Files are stored privately; every download link is short-lived and re-authorized at the moment it
            is issued.
          </p>
        </div>

        {result.error && (
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">{result.error}</div>
        )}

        {canUpload && (
          <div className="space-y-3">
            <SatReportUploadForm />
          </div>
        )}

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Reports ({reports.length})
          </h2>
          {reports.length === 0 && (
            <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
              No combined reports visible for your scope.
            </div>
          )}
          {reports.map((r) => (
            <div key={r.id} className="card p-3 space-y-2 border-border/80 bg-surface/80">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-foreground">
                    {formatDateMY(r.operational_date)} · v{r.version} · {r.status}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{r.shift_coverage}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">Uploaded {formatDateTimeMY(r.uploaded_at)}</p>
                </div>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="btn-secondary px-3 py-1 text-xs shrink-0">
                    Download →
                  </a>
                ) : (
                  <span className="font-mono text-[11px] text-brand shrink-0">{r.deniedReason ?? "Unavailable"}</span>
                )}
              </div>
              {canUpload && r.status === "active" && <SatReportReplaceForm oldReportId={r.id} />}
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
