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
import { CloseCaseForm, EvidenceOpenButton, EvidenceUploadForm, LinkFlightForm, LinkStaffForm } from "@/components/avsec/investigation/CaseExtras";
import { getCaseAudit, getCaseTimeline, listCaseEvidence, listCaseLinks } from "@/lib/phase8/investigation-extras";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function InvestigationCaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { activeRole } = await requirePhase8Role(["investigation_sso", "investigation_so", "investigation_aso", "main_enforcement"]);
  const isMainEnforcement = activeRole === "main_enforcement";
  const isSso = activeRole === "investigation_sso";

  const [caseResult, notesResult, reportsResult, staffResult, linksResult, evidenceResult, timelineResult, auditResult] = await Promise.all([
    getInvestigationCase(id),
    listInvestigationCaseNotes(id),
    listInvestigationCaseReports(id),
    listInvestigationStaff(),
    listCaseLinks(id),
    listCaseEvidence(id),
    getCaseTimeline(id),
    getCaseAudit(id),
  ]);

  if (!caseResult.ok || !caseResult.data) {
    return (
      <main className="min-h-screen pb-32">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="card p-4 border-destructive/50 bg-destructive/10 text-xs text-destructive font-mono">
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
  const links = linksResult.data ?? [];
  const evidence = evidenceResult.data ?? [];
  const timeline = timelineResult.data ?? [];
  const audit = auditResult.data ?? [];
  const isClosed = c.status === "closed";
  const canReopen = isSso || isMainEnforcement;
  const canClose = (isSso || isMainEnforcement) && c.status === "resolved";
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

        {canClose && <CloseCaseForm caseId={c.id} />}
        {canReopen && (c.status === "resolved" || c.status === "closed") && <ReopenCaseForm caseId={c.id} />}
        {isClosed && (
          <p className="card p-3 font-mono text-xs text-muted-foreground" role="status">
            This case is closed and immutable: nothing can be added until it is reopened.
          </p>
        )}

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

        <section className="space-y-2.5" aria-label="Flights and staff">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Linked flights &amp; staff ({links.length})</h2>
          {links.map((l) => (
            <div key={l.id} className="card border-border/80 bg-surface/80 p-3">
              <p className="text-sm font-semibold">
                {l.linkType === "flight" ? `Flight ${l.flightNumber}${l.flightDate ? ` · ${l.flightDate}` : ""}` : `Staff ${l.staffNo} · ${l.staffName}`}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {l.note ?? "—"} · linked by {l.linkedByName} · {formatDateTimeMY(l.linkedAt)}
              </p>
            </div>
          ))}
          {canAct && !isClosed && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <LinkFlightForm caseId={c.id} />
              <LinkStaffForm caseId={c.id} />
            </div>
          )}
        </section>

        <section className="space-y-2.5" aria-label="Evidence">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Evidence ({evidence.length})</h2>
          {evidence.map((e) => (
            <div key={e.id} className="card flex flex-wrap items-center justify-between gap-2 border-border/80 bg-surface/80 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{e.fileName}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {e.description ?? "—"} · {Math.ceil(e.sizeBytes / 1024)} KB · {e.uploadedByName} · {formatDateTimeMY(e.uploadedAt)}
                </p>
              </div>
              <EvidenceOpenButton evidenceId={e.id} fileName={e.fileName} />
            </div>
          ))}
          {canAct && !isClosed && <EvidenceUploadForm caseId={c.id} />}
        </section>

        <section className="space-y-2.5" aria-label="Timeline">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Actions &amp; findings timeline ({timeline.length})</h2>
          <ol className="space-y-1.5">
            {timeline.map((t, i) => (
              <li key={`${t.type}-${i}`} className="card border-border/80 bg-surface/80 p-3">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {formatDateTimeMY(t.at)} · {t.type.replace("_", " ")} · {t.actor ?? "system"}
                </p>
                <p className="text-sm">{t.summary}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-2.5" aria-label="Audit history">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Audit history ({audit.length})</h2>
          <ul className="space-y-1">
            {audit.map((a) => (
              <li key={a.id} className="font-mono text-[11px] text-muted-foreground">
                {formatDateTimeMY(a.at)} · {a.action} · {a.actor ?? "system"}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
