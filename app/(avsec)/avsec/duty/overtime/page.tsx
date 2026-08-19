import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getVisibleOvertimeRequests } from "@/lib/avsec/duty/overtime-queries";
import { createClient } from "@/lib/avsec/supabase/server";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { BottomNav } from "@/components/avsec/layout/BottomNav";
import { formatDateMY } from "@/lib/avsec/datetime";

const FILTERS = ["ALL", "PENDING", "ENDORSED", "APPROVED", "REJECTED"] as const;

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--faint)",
  endorsed: "var(--blue)",
  approved: "var(--green)",
  rejected: "var(--red)",
  cancelled: "var(--faint)",
};

export default async function OvertimeListPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const rows = await getVisibleOvertimeRequests();

  const active = FILTERS.includes(searchParams.status as (typeof FILTERS)[number])
    ? (searchParams.status as (typeof FILTERS)[number])
    : "ALL";
  const filtered = active === "ALL" ? rows : rows.filter((r) => r.status.toUpperCase() === active);

  const otherIds = Array.from(new Set(rows.map((r) => r.profile_id).filter((id) => id !== profile.id)));
  let nameById = new Map<string, string>();
  if (otherIds.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase.from("profiles").select("id, name").in("id", otherIds);
    nameById = new Map((data ?? []).map((p) => [p.id, p.name]));
  }

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Overtime" backHref="/avsec/duty" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <Link href="/avsec/duty/overtime/new" className="btn-primary w-full block text-center">
          New request
        </Link>

        <div className="flex gap-1.5 flex-wrap">
          {FILTERS.map((f) => {
            const on = f === active;
            return (
              <Link
                key={f}
                href={f === "ALL" ? "/duty/overtime" : `/duty/overtime?status=${f}`}
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

        {filtered.length === 0 && (
          <p className="text-sm" style={{ color: "var(--soft)" }}>
            No overtime requests found.
          </p>
        )}

        <div>
          {filtered.map((r) => {
            const color = STATUS_COLOR[r.status] ?? "var(--faint)";
            const mine = r.profile_id === profile.id;
            return (
              <Link
                key={r.id}
                href={`/avsec/duty/overtime/${r.id}`}
                className="flex items-center gap-3 py-3"
                style={{ borderBottom: "1px solid var(--line2)" }}
              >
                <span className="w-[3px] h-[38px] shrink-0" style={{ background: color }} />
                <div className="min-w-0 flex-1">
                  <p className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
                    {formatDateMY(r.work_date + "T00:00:00+08:00")}
                  </p>
                  <p className="font-semibold text-[13px] mt-[3px] truncate" style={{ color: "var(--ink2)" }}>
                    {r.category.replace(/_/g, " ")} · {Number(r.hours).toFixed(2)}h
                  </p>
                  <p className="t-mono text-[10.5px] mt-[3px] truncate" style={{ color: "var(--soft)" }}>
                    {mine ? "by you" : `by ${nameById.get(r.profile_id) ?? "team member"}`}
                  </p>
                </div>
                <span
                  className="t-mono text-[8.5px] font-semibold px-1.5 py-1 shrink-0"
                  style={{ letterSpacing: "0.08em", color, border: `1px solid ${color}` }}
                >
                  {r.status.toUpperCase()}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
