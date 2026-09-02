import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getVisibleOvertimeRequests } from "@/lib/avsec/duty/overtime-queries";
import { createClient } from "@/lib/supabase/server";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { formatDateMY } from "@/lib/avsec/datetime";

const FILTERS = ["ALL", "PENDING", "ENDORSED", "APPROVED", "REJECTED"] as const;

const STATUS_CLASS: Record<string, string> = {
  pending: "text-muted-foreground border-border",
  endorsed: "text-primary border-primary",
  approved: "text-success border-success",
  rejected: "text-brand border-brand",
  cancelled: "text-muted-foreground border-border",
};

export default async function OvertimeListPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
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
    <main className="min-h-screen bg-background pb-28">
      <div className="flex items-center gap-3 border-b border-border px-6 py-[18px]">
        <Link
          href="/avsec/duty"
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center font-mono text-base text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr;
        </Link>
        <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">OVERTIME</span>
      </div>

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Link href="/avsec/duty/overtime/new" className="vecta-btn-primary block w-full text-center">
          New request
        </Link>

        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const on = f === active;
            return (
              <Link
                key={f}
                href={f === "ALL" ? "/avsec/duty/overtime" : `/avsec/duty/overtime?status=${f}`}
                className={`rounded-full border px-3 py-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {f}
              </Link>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">No overtime requests found.</p>
        )}

        <div className="space-y-2">
          {filtered.map((r) => {
            const statusClass = STATUS_CLASS[r.status] ?? "text-muted-foreground border-border";
            const mine = r.profile_id === profile.id;
            return (
              <Link key={r.id} href={`/avsec/duty/overtime/${r.id}`} className="vecta-panel flex items-center gap-3 !py-4">
                <span className={`h-[38px] w-[3px] shrink-0 rounded-full ${statusClass.split(" ")[0].replace("text-", "bg-")}`} />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[9.5px] text-muted-foreground">
                    {formatDateMY(r.work_date + "T00:00:00+08:00")}
                  </p>
                  <p className="mt-[3px] truncate text-[13px] font-semibold text-foreground">
                    {r.category.replace(/_/g, " ")} · {Number(r.hours).toFixed(2)}h
                  </p>
                  <p className="mt-[3px] truncate font-mono text-[10.5px] text-muted-foreground">
                    {mine ? "by you" : `by ${nameById.get(r.profile_id) ?? "team member"}`}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full border px-1.5 py-1 font-mono text-[8.5px] font-semibold tracking-[0.08em] ${statusClass}`}>
                  {r.status.toUpperCase()}
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} />
    </main>
  );
}
