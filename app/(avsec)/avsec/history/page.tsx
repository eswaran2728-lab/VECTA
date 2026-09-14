import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getMySubmissions } from "@/lib/avsec/reports/queries";
import { getAttachmentCounts } from "@/lib/avsec/attachments/actions";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatTimeMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";

const STATUS_FILTERS = ["ALL", "SUBMITTED", "DRAFT"] as const;
const FLIGHT_FILTERS = [
  { label: "ALL TYPES", value: "ALL" },
  { label: "ARRIVALS", value: "ARRIVAL" },
  { label: "DEPARTURES", value: "DEPARTURE" },
] as const;

export default async function HistoryPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ status?: string; flight_type?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const submissions = await getMySubmissions({ profileId: profile.id, limit: 200 });
  const attachmentCounts = await getAttachmentCounts(submissions.map((r) => r.id));

  const activeStatus = STATUS_FILTERS.includes(searchParams.status?.toUpperCase() as (typeof STATUS_FILTERS)[number])
    ? (searchParams.status?.toUpperCase() as (typeof STATUS_FILTERS)[number])
    : "ALL";

  const activeFlight = FLIGHT_FILTERS.some((f) => f.value === searchParams.flight_type?.toUpperCase())
    ? (searchParams.flight_type?.toUpperCase() as "ALL" | "ARRIVAL" | "DEPARTURE")
    : "ALL";

  const rows = submissions.filter((r) => {
    if (activeStatus !== "ALL" && r.status.toUpperCase() !== activeStatus) return false;
    if (activeFlight !== "ALL") {
      if (r.type !== "sec016") return false;
      if (r.flight_type?.toUpperCase() !== activeFlight) return false;
    }
    return true;
  });

  const makeFilterUrl = (newStatus: string, newFlight: string) => {
    const params = new URLSearchParams();
    if (newStatus !== "ALL") params.set("status", newStatus);
    if (newFlight !== "ALL") params.set("flight_type", newFlight);
    const qs = params.toString();
    return qs ? `/history?${qs}` : "/history";
  };

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Submission History</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Browse and review your logged reports, patrol records, and shift submissions.
          </p>
        </div>

        <div className="card p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-border/80">
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Status:</span>
            {STATUS_FILTERS.map((f) => {
              const on = f === activeStatus;
              return (
                <Link
                  key={f}
                  href={makeFilterUrl(f, activeFlight)}
                  className={cn(
                    "font-mono text-xs font-semibold px-2.5 py-1 rounded transition-all",
                    on
                      ? "bg-primary text-primary-foreground font-bold shadow-sm"
                      : "bg-surface hover:bg-muted text-muted-foreground border border-border/60"
                  )}
                >
                  {f}
                </Link>
              );
            })}
          </div>

          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mr-1">SEC016:</span>
            {FLIGHT_FILTERS.map((f) => {
              const on = f.value === activeFlight;
              return (
                <Link
                  key={f.value}
                  href={makeFilterUrl(activeStatus, f.value)}
                  className={cn(
                    "font-mono text-xs font-semibold px-2.5 py-1 rounded transition-all",
                    on
                      ? "bg-primary text-primary-foreground font-bold shadow-sm"
                      : "bg-surface hover:bg-muted text-muted-foreground border border-border/60"
                  )}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="card p-8 text-center space-y-2 border-dashed">
            <p className="text-sm font-semibold text-foreground">No submissions found</p>
            <p className="text-xs text-muted-foreground">
              Try changing the status or movement filter above.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {rows.map((r) => {
              const submitted = r.status === "submitted";
              return (
                <Link
                  key={`${r.type}-${r.id}`}
                  href={`/avsec/reports/view/${r.type}/${r.id}`}
                  className="card p-4 flex items-center justify-between gap-3 border-border/80 bg-surface/80 hover:border-primary/60 transition-all block"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold text-primary">
                        {REPORT_META[r.type].code}
                        {r.report_no ? ` · ${r.report_no}` : ""}
                      </span>
                      {r.flight_type && (
                        <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface border border-border/60 text-muted-foreground">
                          {r.flight_type}
                        </span>
                      )}
                    </div>
                    <p className="font-semibold text-sm text-foreground truncate">
                      {REPORT_META[r.type].name}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground truncate">
                      {r.summary}
                      {attachmentCounts[r.id] ? ` · 📎 ${attachmentCounts[r.id]}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0 space-y-1">
                    <span
                      className={cn(
                        "font-mono text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border",
                        submitted
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                          : "bg-muted text-muted-foreground border-border"
                      )}
                    >
                      {r.status.toUpperCase()}
                    </span>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {formatTimeMY(r.submitted_at ?? r.created_at)}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
