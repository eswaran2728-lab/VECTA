import { getOpsDashboardHubBreakdown, getOpsDashboardSummary, getReportCountsSecure } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

const ROLE_LABEL: Record<string, string> = {
  airasia_management: "AirAsia Management",
  ghod: "GHOD",
  global_reporting_controller: "VECTA Global Reporting Controller",
  super_admin: "Super Admin",
};

/**
 * International executive dashboard: AirAsia Management, GHOD, Global
 * Reporting Controller, Super Admin. Aggregate-only, Malaysia-wide (the
 * only currently-active AOC) figures -- no per-report detail, no staff
 * records, no rosters. GHOD's additional flagged-report detail access
 * (Phase 6's flagged-report path) and Super Admin's technical-admin
 * placeholders are explicitly out of scope for this pass (see the Phase 7
 * report's Known Limitations section) -- this component renders the shared
 * aggregate view every international role gets.
 */
export async function ExecutiveDashboard({ context }: { context: RoleAssignmentContext }) {
  const [reportCounts, opsSummary, hubBreakdown] = await Promise.all([
    getReportCountsSecure("source_table"),
    getOpsDashboardSummary(),
    getOpsDashboardHubBreakdown(),
  ]);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">{ROLE_LABEL[context.roleCode] ?? context.roleCode} — Executive Overview</h1>
        <p className="font-mono text-xs text-muted-foreground">
          Malaysia AOC · international executive scope · aggregate data only
        </p>
      </header>

      <DashboardCard title="Reports by Type (Malaysia-wide)" status={reportCounts.status}>
        <div className="flex flex-wrap gap-2">
          {reportCounts.rows.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">No reports indexed yet for this scope.</p>
          )}
          {reportCounts.rows.map((r) => (
            <StatTile key={r.groupValue} label={r.groupValue} value={r.reportCount} />
          ))}
        </div>
      </DashboardCard>

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
    </div>
  );
}
