import Link from "next/link";
import { getEntityReportCounts, getWorkforceSummary } from "@/lib/dashboard/entity-leadership";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

/**
 * MAA Boss / AAX Boss: ONE entity overview. Report counts follow the same authorization as search (own entity only); the workforce
 * overview is Malaysia-wide and combined. "Reports" and "Staff Directory" are separate functions with separate buttons. There is no
 * duplicate operations-dashboard entry, and no registration approval, technical-admin or report-content-edit authority here.
 */
export async function EntityDashboard({ context }: { context: RoleAssignmentContext }) {
  const entityLabel = context.roleCode.startsWith("maa") ? "MAA" : "AAX";
  const [counts, workforce] = await Promise.all([getEntityReportCounts(), getWorkforceSummary()]);

  const combined = workforce.rows.reduce(
    (acc, r) => ({
      activeStaff: acc.activeStaff + r.activeStaff,
      checkedIn: acc.checkedIn + r.checkedIn,
      pending: acc.pending + r.pending,
      absent: acc.absent + r.absent,
      generatedAt: acc.generatedAt ?? r.generatedAt,
    }),
    { activeStaff: 0, checkedIn: 0, pending: 0, absent: 0, generatedAt: null as string | null },
  );

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold">{entityLabel} Boss — Entity Overview</h1>
        <p className="font-mono text-xs text-muted-foreground">Malaysia AOC · {entityLabel} operating entity</p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/avsec/entity-reports" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          {entityLabel} Reports
        </Link>
        <Link href="/avsec/directory" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Staff Directory
        </Link>
        <Link href="/avsec/bay-board" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Bay Board
        </Link>
        <Link href="/avsec/management/announcements" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Malaysia Announcements
        </Link>
      </div>

      <DashboardCard title={`${entityLabel} reports by type`} status={counts.status}>
        <div className="flex flex-wrap gap-2">
          <StatTile label={`${entityLabel} total`} value={counts.entityTotal} />
          {counts.rows.map((r) => (
            <StatTile key={r.sourceTable} label={r.label} value={r.total} />
          ))}
        </div>
        <Link href="/avsec/entity-reports" className="font-mono text-xs text-primary">
          Search and open reports →
        </Link>
      </DashboardCard>

      <DashboardCard title="Malaysia workforce today (MAA + AAX)" status={workforce.status} generatedAt={combined.generatedAt}>
        <div className="flex flex-wrap gap-2">
          <StatTile label="Active staff" value={combined.activeStaff} />
          <StatTile label="Checked in" value={combined.checkedIn} />
          <StatTile label="Pending" value={combined.pending} />
          <StatTile label="Absent" value={combined.absent} />
        </div>
        {workforce.rows.length > 1 && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {workforce.rows.map((r) => `${r.entityCode}: ${r.checkedIn}/${r.activeStaff} checked in`).join(" · ")}
          </p>
        )}
      </DashboardCard>
    </div>
  );
}
