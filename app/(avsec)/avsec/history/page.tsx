import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getMySubmissions } from "@/lib/avsec/reports/queries";
import { getAttachmentCounts } from "@/lib/avsec/attachments/actions";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatTimeMY } from "@/lib/avsec/datetime";

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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="t-mono text-[9px] uppercase tracking-wider text-muted-foreground mr-1">Status:</span>
            {STATUS_FILTERS.map((f) => {
              const on = f === activeStatus;
              return (
                <Link
                  key={f}
                  href={makeFilterUrl(f, activeFlight)}
                  className="t-mono text-[9.5px] font-semibold px-2.5 py-1.5 rounded"
                  style={{
                    letterSpacing: "0.1em",
                    border: `1px solid ${on ? "var(--gold-fill)" : "var(--line3)"}`,
                    background: on ? "var(--gold-soft)" : "transparent",
                    color: on ? "var(--gold)" : "var(--mid)",
                  }}
                >
                  {f}
                </Link>
              );
            })}
          </div>

          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="t-mono text-[9px] uppercase tracking-wider text-muted-foreground mr-1">SEC016 Movement:</span>
            {FLIGHT_FILTERS.map((f) => {
              const on = f.value === activeFlight;
              return (
                <Link
                  key={f.value}
                  href={makeFilterUrl(activeStatus, f.value)}
                  className="t-mono text-[9.5px] font-semibold px-2.5 py-1.5 rounded"
                  style={{
                    letterSpacing: "0.1em",
                    border: `1px solid ${on ? "var(--gold-fill)" : "var(--line3)"}`,
                    background: on ? "var(--gold-soft)" : "transparent",
                    color: on ? "var(--gold)" : "var(--mid)",
                  }}
                >
                  {f.label}
                </Link>
              );
            })}
          </div>
        </div>

        {rows.length === 0 && (
          <p className="text-sm" style={{ color: "var(--soft)" }}>
            No submissions found.
          </p>
        )}

        <div>
          {rows.map((r) => {
            const submitted = r.status === "submitted";
            const color = submitted ? "var(--gold)" : "var(--faint)";
            return (
              <Link
                key={`${r.type}-${r.id}`}
                href={`/avsec/reports/view/${r.type}/${r.id}`}
                className="flex items-center gap-3 py-3"
                style={{ borderBottom: "1px solid var(--line2)" }}
              >
                <span className="w-[3px] h-[38px] shrink-0" style={{ background: color }} />
                <div className="min-w-0 flex-1">
                  <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
                    {REPORT_META[r.type].code}
                    {r.report_no ? ` · ${r.report_no}` : ""}
                  </p>
                  <p className="font-semibold text-[13px] mt-[3px] truncate" style={{ color: "var(--ink2)" }}>
                    {REPORT_META[r.type].name}
                  </p>
                  <p className="t-mono text-[10.5px] mt-[3px] truncate" style={{ color: "var(--soft)" }}>
                    {r.summary}
                    {attachmentCounts[r.id] ? ` · 📎 ${attachmentCounts[r.id]}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <span
                    className="t-mono text-[8.5px] font-semibold px-1.5 py-1"
                    style={{ letterSpacing: "0.08em", color, border: `1px solid ${color}` }}
                  >
                    {r.status.toUpperCase()}
                  </span>
                  <p className="t-mono text-[9.5px] mt-1.5" style={{ color: "var(--faint)" }}>
                    {formatTimeMY(r.submitted_at ?? r.created_at)}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
