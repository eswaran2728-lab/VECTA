import Link from "next/link";
import { groupAllowedReportForms } from "@/lib/avsec/reports/report-categories";

/**
 * Categorised "file a report" entry points. `allowed` must come from the database-backed form assignments
 * (getAllowedReportForms); this component only groups and renders it. A category with no permitted form renders nothing, and a person
 * with no permitted form sees the empty note instead of dead cards.
 */
export function ReportCategoryGroups({ allowed, layout }: { allowed: readonly string[]; layout: "grid" | "list" }) {
  const groups = groupAllowedReportForms(allowed);
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No report forms are assigned to you. History stays available.</p>;
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`report-cat-${g.id}`} data-report-category={g.id}>
          <h3 id={`report-cat-${g.id}`} className="mb-2 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {g.title}
          </h3>
          <ul className={layout === "grid" ? "grid grid-cols-1 gap-2 min-[420px]:grid-cols-2" : "flex flex-col gap-2"}>
            {g.forms.map((f) => (
              <li key={f.type}>
                <Link
                  href={f.href}
                  data-report-form={f.type}
                  className="flex min-h-[56px] flex-col justify-center rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-primary"
                >
                  <span className="font-mono text-xs text-muted-foreground">{f.code}</span>
                  <span className="mt-0.5 text-sm font-semibold leading-tight text-foreground">{f.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
