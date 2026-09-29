import Link from "next/link";
import { getOpsDashboardHubBreakdown, getOpsDashboardSummary } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";

/**
 * Malaysia-wide Operation dashboard for the Operation Manager role: movement
 * / staffing summary, hub breakdown, and links into the existing roster,
 * leave, OT, report and Bay Board surfaces. The Operation Manager remains
 * the final approver per the existing workflow -- this dashboard shows
 * queues and links only, it does not reimplement or bypass the existing
 * approval engine (that logic is untouched, in its existing routes).
 */
export async function OperationManagerDashboard() {
  const [opsSummary, hubBreakdown] = await Promise.all([getOpsDashboardSummary(), getOpsDashboardHubBreakdown()]);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">Operation Manager — Malaysia Operation Dashboard</h1>
        <p className="font-mono text-xs text-muted-foreground">Malaysia AOC · Operation department · Malaysia-wide scope</p>
      </header>

      <DashboardCard title="Staffing Today" status={opsSummary.status} generatedAt={opsSummary.data?.generatedAt}>
        {opsSummary.data && (
          <div className="flex flex-wrap gap-2">
            <StatTile label="Checked In" value={opsSummary.data.checkedInCount} />
            <StatTile label="Pending" value={opsSummary.data.pendingCount} />
            <StatTile label="Absent" value={opsSummary.data.absentCount} />
            <StatTile label="Total Rostered" value={opsSummary.data.totalStaff} />
            <StatTile label="Bay Board Overdue" value={opsSummary.data.overdueBayBoardCount} />
          </div>
        )}
      </DashboardCard>

      <DashboardCard title="Staffing by Hub" status={hubBreakdown.status}>
        {hubBreakdown.rows.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">No duty records for today yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {hubBreakdown.rows.map((r) => (
              <StatTile key={r.hubCode} label={r.hubCode} value={`${r.checkedInCount}/${r.totalStaff}`} />
            ))}
          </div>
        )}
      </DashboardCard>

      <section className="card p-4 space-y-2">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">Queues &amp; Links</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link href="/avsec/admin/roster" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            Roster queue
          </Link>
          <Link href="/avsec/admin/absences" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            Leave / OT queue
          </Link>
          <Link href="/avsec/bay-board" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            Bay Board
          </Link>
          <Link href="/avsec/dashboard" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            Reports
          </Link>
          <Link
            href="/icms/dashboard"
            className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40"
          >
            CaterLink (ICMS)
          </Link>
        </div>
      </section>
    </div>
  );
}
