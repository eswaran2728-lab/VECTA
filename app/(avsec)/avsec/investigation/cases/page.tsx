import Link from "next/link";
import { requirePhase8Role } from "@/lib/phase8/auth";
import { listInvestigationCases } from "@/lib/phase8/investigation";
import { OpenCaseForm } from "@/components/avsec/investigation/InvestigationForms";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function InvestigationCasesPage() {
  const { activeRole } = await requirePhase8Role(["investigation_sso", "investigation_so", "investigation_aso", "main_enforcement"]);
  const canOpen = activeRole !== "main_enforcement";

  const result = await listInvestigationCases();
  const cases = result.data ?? [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold font-display">Investigation Cases</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Malaysia AOC, Investigation SSO/SO/ASO. Every report link uses the Phase 6 authorized
            search — no direct table reads.
          </p>
        </div>

        {result.error && (
          <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">{result.error}</div>
        )}

        {canOpen && <OpenCaseForm />}

        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Cases ({cases.length})
          </h2>
          {cases.length === 0 && (
            <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">No cases found.</div>
          )}
          {cases.map((c) => (
            <Link
              key={c.id}
              href={`/avsec/investigation/cases/${c.id}`}
              className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80 hover:border-primary/60 transition-all block"
            >
              <div className="min-w-0">
                <p className="font-mono text-xs font-bold text-primary">{c.case_no}</p>
                <p className="font-semibold text-sm text-foreground">{c.title}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {c.priority} · {c.status} {c.reopened_count > 0 ? `· reopened ${c.reopened_count}x` : ""}
                </p>
              </div>
              <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">
                {formatDateTimeMY(c.created_at)}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
