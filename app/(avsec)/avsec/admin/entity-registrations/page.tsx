import { requireEntityLeadership } from "@/lib/dashboard/entity-guard";
import { listEntityRegistrationRequests } from "@/lib/avsec/admin/entity-registrations";
import { EntityRegistrationsView } from "@/components/avsec/admin/EntityRegistrationsView";

/**
 * MAA/AAX Admin registration administration. Gated by an active maa_admin / aax_admin canonical assignment (never by legacy
 * profiles.role); the list, the assignment options and the approval are all re-authorized inside the database for that admin's own
 * entity. A Boss reaches this route only to be sent back to their dashboard.
 */
export default async function EntityRegistrationsPage() {
  const { leadership } = await requireEntityLeadership("admin");
  const result = await listEntityRegistrationRequests();

  return (
    <main className="min-h-screen pb-16">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-[0.03em] text-foreground">{leadership.entityCode} Registration Administration</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Review, approve (assigning role and scope) or reject registration requests for {leadership.entityCode}. Requests for the other
            entity never appear here.
          </p>
        </div>
        {!result.ok ? (
          <p className="text-sm text-red-500" role="alert">
            {result.error}
          </p>
        ) : (
          <EntityRegistrationsView requests={result.rows} />
        )}
      </div>
    </main>
  );
}
