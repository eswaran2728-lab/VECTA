import Link from "next/link";
import { getOpsDashboardHubBreakdown, getOpsDashboardSummary, getReportCountsSecure } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";
import type { HubLink } from "@/lib/dashboard/linkHubConfig";

export type { HubLink };

/**
 * Shared "composed, not rebuilt" dashboard for every Phase 3 role that gets
 * real, secure aggregate/staffing data (via the same Phase 6/7 RPCs the
 * other Phase 7 dashboards use) plus a set of links into EXISTING,
 * already-authorized routes -- never a reimplementation of those routes'
 * own logic.
 *
 * Used for: Main Enforcement, Compliance, CaterLink Management, Global
 * Reporting Controller, Investigation SSO/SO/ASO, SAT ASO, Profiling SO/
 * ASO, Hub SE, DSE, SSO/SO/ASO -- see the Phase 7 closure report for which
 * of these get real staffing/report cards (station/hub/department-scoped
 * roles do; roles whose scope this pass cannot safely resolve render only
 * their links, with the cards showing an explicit unauthorized state, not
 * a silent zero).
 */
export async function GenericLinkHubDashboard({
  context,
  title,
  subtitle,
  links,
  showReportCounts = true,
  showStaffing = true,
  showHubBreakdown = false,
}: {
  context: RoleAssignmentContext;
  title: string;
  subtitle: string;
  links: HubLink[];
  showReportCounts?: boolean;
  showStaffing?: boolean;
  showHubBreakdown?: boolean;
}) {
  const [reportCounts, opsSummary, hubBreakdown] = await Promise.all([
    showReportCounts ? getReportCountsSecure("source_table") : Promise.resolve(null),
    showStaffing ? getOpsDashboardSummary() : Promise.resolve(null),
    showHubBreakdown ? getOpsDashboardHubBreakdown() : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">{title}</h1>
        <p className="font-mono text-xs text-muted-foreground">{subtitle}</p>
      </header>

      {reportCounts && (
        <DashboardCard title="Authorized Reports" status={reportCounts.status}>
          <div className="flex flex-wrap gap-2">
            {reportCounts.rows.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">No reports in scope yet.</p>
            )}
            {reportCounts.rows.map((r) => (
              <StatTile key={r.groupValue} label={r.groupValue} value={r.reportCount} />
            ))}
          </div>
        </DashboardCard>
      )}

      {opsSummary && (
        <DashboardCard title="Staffing Today" status={opsSummary.status} generatedAt={opsSummary.data?.generatedAt}>
          {opsSummary.data && (
            <div className="flex flex-wrap gap-2">
              <StatTile label="Checked In" value={opsSummary.data.checkedInCount} />
              <StatTile label="Pending" value={opsSummary.data.pendingCount} />
              <StatTile label="Absent" value={opsSummary.data.absentCount} />
              <StatTile label="Total Rostered" value={opsSummary.data.totalStaff} />
            </div>
          )}
        </DashboardCard>
      )}

      {hubBreakdown && (
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
      )}

      <section className="card p-4 space-y-2">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">Links</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
              {l.label}
            </Link>
          ))}
        </div>
      </section>

      <p className="font-mono text-[10px] text-muted-foreground">
        {context.roleCode}
        {context.hubCode ? ` · hub: ${context.hubCode}` : ""}
        {context.stationCode ? ` · station: ${context.stationCode}` : ""}
        {context.teamName ? ` · team: ${context.teamName}` : ""}
      </p>
    </div>
  );
}
