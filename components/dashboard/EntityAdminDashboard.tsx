import Link from "next/link";
import { getEntityAdminSummary } from "@/lib/dashboard/aggregates";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";
import type { RoleAssignmentContext } from "@/lib/dashboard/context";

/**
 * MAA Admin / AAX Admin: registration/assignment-queue and directory
 * summary for their own entity, via get_entity_admin_summary_secure()
 * (entity-scoped through active user_entity_memberships, never via
 * station). Deliberately NO boss-level report-detail access -- this
 * dashboard shows no report cards at all.
 */
export async function EntityAdminDashboard({ context }: { context: RoleAssignmentContext }) {
  const summary = await getEntityAdminSummary();
  const entityLabel = context.roleCode.startsWith("maa") ? "MAA" : "AAX";

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="font-bold text-lg">{entityLabel} Admin — Entity Administration</h1>
        <p className="font-mono text-xs text-muted-foreground">
          Malaysia AOC · {entityLabel} entity administration scope · no report-detail access
        </p>
      </header>

      <DashboardCard title="Directory" status={summary.status} generatedAt={summary.data?.generatedAt}>
        {summary.data && (
          <div className="flex flex-wrap gap-2">
            <StatTile label={`Active ${entityLabel} Staff`} value={summary.data.activeStaffCount} />
            <StatTile label="Pending Registrations (Malaysia-wide)" value={summary.data.malaysiaWidePendingRegistrationCount} />
          </div>
        )}
      </DashboardCard>

      <section className="card p-4 space-y-2">
        <h2 className="font-bold font-mono text-xs uppercase tracking-wider text-muted-foreground">Queues &amp; Links</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link href="/avsec/admin/users" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            User Administration
          </Link>
          <Link href="/avsec/admin/roster" className="rounded-lg border border-border/60 px-3 py-2 text-sm hover:bg-card/40">
            Roster queue
          </Link>
        </div>
      </section>
    </div>
  );
}
