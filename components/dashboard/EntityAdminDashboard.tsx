import Link from "next/link";
import { getEntityAdminOverview, getEntityReportCounts, getWorkforceSummary } from "@/lib/dashboard/entity-leadership";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

/**
 * MAA Admin / AAX Admin: own-entity active staff, the Malaysia-wide pending-registration TOTAL (a count only), a dedicated link
 * to registration administration, own-entity report counts/search, the combined directory and the Bay Board. No boss authority,
 * no cross-entity reports, no Global announcements, and no duty / check-in / leave / overtime surface (an admin is not rostered).
 */
export async function EntityAdminDashboard({ context }: { context: RoleAssignmentContext }) {
  const entityLabel = context.roleCode.startsWith("maa") ? "MAA" : "AAX";
  const [overview, counts, workforce] = await Promise.all([getEntityAdminOverview(), getEntityReportCounts(), getWorkforceSummary()]);
  const own = workforce.rows.find((r) => r.entityCode === entityLabel);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold">{entityLabel} Admin — Entity Administration</h1>
        <p className="font-mono text-xs text-muted-foreground">Malaysia AOC · {entityLabel} entity administration</p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Link href="/avsec/admin/entity-registrations" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Registration Administration
        </Link>
        <Link href="/avsec/admin/entity-staff" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Staff Accounts
        </Link>
        <Link href="/avsec/entity-reports" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          {entityLabel} Reports
        </Link>
        <Link href="/avsec/directory" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Staff Directory
        </Link>
        <Link href="/avsec/bay-board" className="rounded-lg border border-border/60 px-3 py-3 text-sm font-medium hover:bg-card/40 min-h-[44px]">
          Bay Board
        </Link>
      </div>

      <DashboardCard title="Staff and registrations" status={overview.status}>
        <div className="flex flex-wrap gap-2">
          <StatTile label={`Active ${entityLabel} staff`} value={overview.entityActiveStaff} />
          <StatTile label="Pending registrations (Malaysia-wide)" value={overview.malaysiaPendingRegistrations} />
          {own ? <StatTile label={`${entityLabel} checked in today`} value={own.checkedIn} /> : null}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          You review and approve only {entityLabel} requests; the Malaysia-wide figure is a count only.
        </p>
      </DashboardCard>

      <DashboardCard title={`${entityLabel} reports by type`} status={counts.status}>
        <div className="flex flex-wrap gap-2">
          <StatTile label={`${entityLabel} total`} value={counts.entityTotal} />
          {counts.rows.map((r) => (
            <StatTile key={r.sourceTable} label={r.label} value={r.total} />
          ))}
        </div>
      </DashboardCard>
    </div>
  );
}
