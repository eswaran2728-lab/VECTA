import { redirect } from "next/navigation";
import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { searchByReportNoPrefix } from "@/lib/avsec/reports/queries";
import { REPORT_META, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function ReportLookupPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  await requireRole([...ORG_WIDE_ROLES]);
  const q = (searchParams.q || "").trim();

  const results = q ? await searchByReportNoPrefix(q) : [];

  // An exact full-number match with nothing else sharing that prefix jumps straight to
  // the record — the whole point of the physical-form-in-hand lookup.
  if (results.length === 1 && results[0]!.report_no?.toUpperCase() === q.toUpperCase()) {
    redirect(`/avsec/reports/view/${results[0]!.type}/${results[0]!.id}`);
  }

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Report Lookup</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Paste or type a report number from a paper form — full or partial (e.g.{" "}
            <span className="font-mono text-primary">AASEC16-20260818</span> finds every SEC016 filed that day).
          </p>
        </div>

        <form method="get" className="flex gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="e.g. AASEC16-20260818-001"
            autoCapitalize="characters"
            className="input-base flex-1 font-mono text-xs"
          />
          <button type="submit" className="btn-primary shrink-0 text-xs">
            Search
          </button>
        </form>

        {q && (
          <div className="space-y-2.5 pt-2">
            {results.length === 0 && (
              <div className="card p-6 text-center border-dashed text-xs text-muted-foreground">
                No reports found matching &quot;{q}&quot;.
              </div>
            )}
            {results.map((r) => (
              <Link
                key={`${r.type}-${r.id}`}
                href={`/avsec/reports/view/${r.type}/${r.id}`}
                className="card p-4 flex items-center justify-between gap-3 border-border/80 bg-surface/80 hover:border-primary/60 transition-all block"
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-mono text-xs font-bold text-primary">
                    {r.report_no}
                  </p>
                  <p className="font-semibold text-sm text-foreground">
                    {REPORT_META[r.type].name}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {r.summary}
                  </p>
                </div>
                <span className="font-mono text-[11px] shrink-0 text-right text-muted-foreground">
                  {formatDateTimeMY(r.submitted_at ?? r.created_at)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
