import Link from "next/link";
import {
  getFlaggedReportsSecure,
  getOpsDashboardHubBreakdown,
  getOpsDashboardSummary,
  getReportCountsSecure,
} from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

const ROLE_LABEL: Record<string, string> = {
  airasia_management: "AirAsia Management",
  ghod: "GHOD",
  global_reporting_controller: "VECTA Global Reporting Controller",
};

/**
 * International executive dashboard: AirAsia Management, GHOD, Global
 * Reporting Controller. Aggregate-only, Malaysia-wide (the only currently-
 * active AOC) figures -- no per-report detail, no staff records, no
 * rosters. GHOD additionally gets the existing Phase 6 flagged-report path
 * (flagged_reports_secure(), already gated by has_report_access()'s own
 * "GHOD: only while flagged" rule) -- no new authorization, no general
 * report-detail access. Super Admin gets its own dedicated
 * SuperAdminDashboard, not this component (a Malaysia-wide operational
 * aggregate is not an appropriate default for a technical-only role).
 */
export async function ExecutiveDashboard({ context }: { context: RoleAssignmentContext }) {
  const isGhod = context.roleCode === "ghod";
  const [reportCounts, opsSummary, hubBreakdown, flagged] = await Promise.all([
    getReportCountsSecure("source_table"),
    getOpsDashboardSummary(),
    getOpsDashboardHubBreakdown(),
    isGhod ? getFlaggedReportsSecure(1, 10) : Promise.resolve(null),
  ]);

  const totalReports = reportCounts.rows.reduce((sum, r) => sum + r.reportCount, 0);
  const hubsReporting = hubBreakdown.rows.length;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">{ROLE_LABEL[context.roleCode] ?? context.roleCode} — Executive Overview</h1>
        <p className="font-mono text-xs text-muted-foreground">
          Malaysia AOC · international executive scope · aggregate data only
        </p>
      </header>

      <DashboardCard title="Executive Brief" status={reportCounts.status === "ok" && opsSummary.status === "ok" ? "ok" : "error"}>
        <ul className="font-mono text-xs text-foreground list-disc pl-4 space-y-1">
          <li>{hubsReporting} hub{hubsReporting === 1 ? "" : "s"} with duty records today</li>
          <li>{totalReports} report{totalReports === 1 ? "" : "s"} indexed (all types, Malaysia-wide)</li>
          {opsSummary.data && (
            <li>
              {opsSummary.data.checkedInCount} checked in / {opsSummary.data.totalStaff} rostered today
              {opsSummary.data.overdueBayBoardCount > 0 ? ` · ${opsSummary.data.overdueBayBoardCount} Bay Board overdue` : ""}
            </li>
          )}
        </ul>
        <p className="font-mono text-[10px] text-muted-foreground mt-2">
          Deterministic, computed directly from the aggregate figures below. No report content, free text, names, or
          other personal/operational detail is sent anywhere to generate this brief.
        </p>
      </DashboardCard>

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

      {isGhod && flagged && (
        <DashboardCard title="Flagged Reports" status={flagged.status}>
          {flagged.rows.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground">No flagged reports right now.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {flagged.rows.map((r) => (
                <Link
                  key={r.id}
                  href={`/avsec/reports/view/${r.sourceTable.replace(/^report_/, "")}/${r.id}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40"
                >
                  <span className="font-mono text-xs">
                    {r.reportType ?? r.sourceTable} · {r.operatingEntityCode ?? "—"} · {r.reportDate ?? "—"}
                  </span>
                  <span className="font-mono text-xs text-primary">View →</span>
                </Link>
              ))}
            </div>
          )}
        </DashboardCard>
      )}
    </div>
  );
}
