import { getSuperAdminTechnicalStatus } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";

/**
 * Super Admin: technical administration only. Queue/indexing health and
 * pending-approval counts via get_super_admin_technical_status_secure() --
 * no secrets, tokens, service-role credentials or environment values are
 * ever queried or rendered here. Deliberately shows NO report-content
 * card and NO operational dashboard link -- Super Admin does not
 * automatically receive operational report-detail access (see
 * resolve_ops_dashboard_station_scope(), which explicitly rejects
 * super_admin).
 */
export async function SuperAdminDashboard() {
  const status = await getSuperAdminTechnicalStatus();

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">Super Admin — Technical Administration</h1>
        <p className="font-mono text-xs text-muted-foreground">
          Platform technical status only · no automatic operational report access
        </p>
      </header>

      <DashboardCard title="Indexing Queue Health" status={status.status} generatedAt={status.data?.generatedAt}>
        {status.data && (
          <div className="flex flex-wrap gap-2">
            <StatTile label="Pending" value={status.data.queuePending} />
            <StatTile label="Processing" value={status.data.queueProcessing} />
            <StatTile label="Completed" value={status.data.queueCompleted} />
            <StatTile label="Failed" value={status.data.queueFailed} />
            <StatTile label="Permanently Failed" value={status.data.queuePermanentlyFailed} />
          </div>
        )}
      </DashboardCard>

      <DashboardCard title="Pending Approvals" status={status.status}>
        {status.data && (
          <div className="flex flex-wrap gap-2">
            <StatTile label="Registration Requests" value={status.data.pendingRegistrationCount} />
            <StatTile label="Profile Approvals" value={status.data.pendingProfileApprovalCount} />
          </div>
        )}
      </DashboardCard>

      <section className="card p-4 space-y-2">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Deployment / Configuration
        </h2>
        <p className="font-mono text-xs text-muted-foreground italic" role="status">
          Deployment and storage health placeholders are not wired to a live source in this pass — no secure,
          non-secret-leaking data source for them was confirmed available. Shown as a placeholder rather than a
          fabricated status.
        </p>
      </section>
    </div>
  );
}
