import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { getMySubmissions } from "@/lib/reports/queries";
import { REPORT_META } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { formatTimeMY } from "@/lib/datetime";
import { cn } from "@/lib/utils";

const FILTERS = ["ALL", "SUBMITTED", "DRAFT"] as const;

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const profile = await requireProfile();
  const submissions = await getMySubmissions({ profileId: profile.id, limit: 200 });

  const active = FILTERS.includes(searchParams.status as (typeof FILTERS)[number])
    ? (searchParams.status as (typeof FILTERS)[number])
    : "ALL";
  const rows =
    active === "ALL" ? submissions : submissions.filter((r) => r.status.toUpperCase() === active);

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="My submissions" backHref="/home" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => {
            const on = f === active;
            return (
              <Link
                key={f}
                href={f === "ALL" ? "/history" : `/history?status=${f}`}
                className="t-mono text-[9.5px] font-semibold px-3 py-2"
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
                href={`/reports/view/${r.type}/${r.id}`}
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
      <BottomNav profile={profile} />
    </main>
  );
}
