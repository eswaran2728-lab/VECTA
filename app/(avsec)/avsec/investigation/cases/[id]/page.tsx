import { requirePhase8Role } from "@/lib/phase8/auth";
import {
  getInvestigationCase,
  listInvestigationCaseNotes,
  listInvestigationCaseReports,
  listInvestigationStaff,
} from "@/lib/phase8/investigation";
import {
  AddNoteForm,
  AssignCaseForm,
  ResolveCaseForm,
  ReopenCaseForm,
  LinkReportSearch,
} from "@/components/avsec/investigation/InvestigationForms";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function InvestigationCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { activeRole } = await requirePhase8Role(["investigation_sso", "investigation_so", "investigation_aso", "main_enforcement"]);
  const isMainEnforcement = activeRole === "main_enforcement";
  const isSso = activeRole === "investigation_sso";

  const [caseResult, notesResult, reportsResult, staffResult] = await Promise.all([
    getInvestigationCase(id),
    listInvestigationCaseNotes(id),
    listInvestigationCaseReports(id),
    listInvestigationStaff(),
  ]);

  if (!caseResult.ok || !caseResult.data) {
    return (
      <main className="min-h-screen pb-32">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">
            {caseResult.error ?? "Case not found."}
          </div>
        </div>
      </main>
    );
  }

  const c = caseResult.data;
  const notes = notesResult.data ?? [];
  const reports = reportsResult.data ?? [];
  const staff = staffResult.data ?? [];
  const canReopen = isSso || isMainEnforcement;
  const canAct = !isMainEnforcement; // Main Enforcement monitors; does not act on cases.

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div>
          <p className="font-mono text-xs font-bold text-primary">{c.case_no}</p>
          <h1 className="text-xl font-bold font-display">{c.title}</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            {c.priority} · {c.status} {c.reopened_count > 0 ? `· reopened ${c.reopened_count}x` : ""}
          </p>
          {c.description && <p className="text-sm text-foreground mt-2">{c.description}</p>}
          {c.classification && <p className="font-mono text-xs text-muted-foreground">Classification: {c.classification}</p>}
          {c.resolution && (
            <div className="card p-3 mt-2 border-success/50 bg-success/10">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Resolution</p>
              <p className="text-sm text-foreground">{c.resolution}</p>
            </div>
          )}
        </div>

        {canAct && c.status !== "resolved" && c.status !== "closed" && (
          <div className="grid grid-cols-1 gap-2.5">
            <AssignCaseForm caseId={c.id} staff={staff} />
            <ResolveCaseForm caseId={c.id} />
          </div>
        )}

        {canReopen && (c.status === "resolved" || c.status === "closed") && <ReopenCaseForm caseId={c.id} />}

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Linked Reports ({reports.length})
          </h2>
          {reports.map((r) => (
            <div key={r.repository_report_id} className="card p-3 border-border/80 bg-surface/80">
              <p className="font-semibold text-sm text-foreground">{r.report_type.toUpperCase()}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {r.flight_number ?? "—"} · {r.report_date ?? "—"} · linked {formatDateTimeMY(r.linked_at)}
              </p>
            </div>
          ))}
          {canAct && <LinkReportSearch caseId={c.id} />}
        </section>

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Notes / Actions ({notes.length})
          </h2>
          {notes.map((n) => (
            <div key={n.id} className="card p-3 border-border/80 bg-surface/80">
              <p className="text-sm text-foreground">{n.note}</p>
              <p className="font-mono text-[11px] text-muted-foreground mt-1">{formatDateTimeMY(n.created_at)}</p>
            </div>
          ))}
          {canAct && <AddNoteForm caseId={c.id} />}
        </section>
      </div>
    </main>
  );
}
