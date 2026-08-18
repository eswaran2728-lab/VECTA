import { redirect } from "next/navigation";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { searchByReportNoPrefix } from "@/lib/reports/queries";
import { REPORT_META, ORG_WIDE_ROLES } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { formatDateTimeMY } from "@/lib/datetime";

export default async function ReportLookupPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const profile = await requireRole([...ORG_WIDE_ROLES]);
  const q = (searchParams.q || "").trim();

  const results = q ? await searchByReportNoPrefix(q) : [];

  // An exact full-number match with nothing else sharing that prefix jumps straight to
  // the record — the whole point of the physical-form-in-hand lookup.
  if (results.length === 1 && results[0]!.report_no?.toUpperCase() === q.toUpperCase()) {
    redirect(`/reports/view/${results[0]!.type}/${results[0]!.id}`);
  }

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Report Lookup" backHref="/home" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-[13px]" style={{ color: "var(--soft)" }}>
          Paste or type a report number from a paper form — full or partial (e.g.{" "}
          <span className="t-mono">AASEC16-20260818</span> finds every SEC016 filed that day).
        </p>

        <form method="get" className="flex gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="AASEC16-20260818-001"
            autoCapitalize="characters"
            className="input-base flex-1 t-mono"
          />
          <button type="submit" className="btn-primary shrink-0">
            Search
          </button>
        </form>

        {q && (
          <div className="space-y-2">
            {results.length === 0 && (
              <div className="disclaimer-band">No report found with that number.</div>
            )}
            {results.map((r) => (
              <Link
                key={`${r.type}-${r.id}`}
                href={`/reports/view/${r.type}/${r.id}`}
                className="card p-4 flex items-center justify-between gap-3 block"
              >
                <div className="min-w-0">
                  <p className="t-mono text-[11px] font-bold" style={{ color: "var(--gold)" }}>
                    {r.report_no}
                  </p>
                  <p className="font-semibold text-[13px] mt-1" style={{ color: "var(--ink2)" }}>
                    {REPORT_META[r.type].name}
                  </p>
                  <p className="t-mono text-[10.5px] mt-1" style={{ color: "var(--soft)" }}>
                    {r.summary}
                  </p>
                </div>
                <span className="t-mono text-[9.5px] shrink-0 text-right" style={{ color: "var(--faint)" }}>
                  {formatDateTimeMY(r.submitted_at ?? r.created_at)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
