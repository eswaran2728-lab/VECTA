import Link from "next/link";
import { getEntityDashboardSummary, getReportCountsSecure } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

/**
 * MAA Boss / AAX Boss: Malaysia overview + their own entity's detailed-
 * report scope (has_report_access() already grants this per Phase 6) and
 * entity-scoped staffing (via each staff member's own active
 * user_entity_memberships row -- see get_entity_dashboard_aggregate_secure
 * in the Phase 7 closure migration). Bay Board has no per-aircraft entity
 * owner in this schema, so it is explicitly NOT shown here as an
 * entity-scoped figure -- see the "not available for this scope" card.
 */
export async function EntityDashboard({ context }: { context: RoleAssignmentContext }) {
  const [entitySummary, reportCounts] = await Promise.all([
    getEntityDashboardSummary(),
    getReportCountsSecure("operating_entity_code"),
  ]);

  const entityLabel = context.roleCode.startsWith("maa") ? "MAA" : "AAX";
  const ownEntityReportRow = reportCounts.rows.find((r) => r.groupValue === entityLabel);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">{entityLabel} Boss — Entity Overview</h1>
        <p className="font-mono text-xs text-muted-foreground">Malaysia AOC · {entityLabel} operating entity scope</p>
      </header>

      <DashboardCard title={`${entityLabel} Reports`} status={reportCounts.status}>
        <div className="flex flex-wrap gap-2">
          <StatTile label={entityLabel} value={ownEntityReportRow?.reportCount ?? 0} />
        </div>
        <Link href="/avsec/reports/lookup" className="font-mono text-xs text-primary">
          Report search →
        </Link>
      </DashboardCard>

      <DashboardCard
        title={`${entityLabel} Staffing Today`}
        status={entitySummary.status}
        generatedAt={entitySummary.data?.generatedAt}
      >
        {entitySummary.data && (
          <div className="flex flex-wrap gap-2">
            <StatTile label="Checked In" value={entitySummary.data.checkedInCount} />
            <StatTile label="Pending" value={entitySummary.data.pendingCount} />
            <StatTile label="Absent" value={entitySummary.data.absentCount} />
            <StatTile label={`Active ${entityLabel} Staff`} value={entitySummary.data.totalStaff} />
          </div>
        )}
      </DashboardCard>

      <section className="card p-4 space-y-2">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">Bay Board</h2>
        <p className="font-mono text-xs text-muted-foreground italic" role="status">
          Not available at entity scope: Bay Board aircraft are recorded per station, not per operating entity, and
          this schema has no station-to-entity mapping (any entity may operate at any station). Showing a number here
          would require guessing an entity from a station, which this dashboard does not do.
        </p>
      </section>
    </div>
  );
}
