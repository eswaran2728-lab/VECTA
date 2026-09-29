import { redirect } from "next/navigation";
import { requireProfile, landingPathForRole } from "@/lib/avsec/auth";
import { resolveDashboardContext, tierForRoleCode } from "@/lib/dashboard/context";
import { ContextSelector } from "@/components/dashboard/ContextSelector";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";
import { OperationManagerDashboard } from "@/components/dashboard/OperationManagerDashboard";

/**
 * Phase 7 dashboard-context entry point (/avsec/my-dashboard). Placed
 * inside the existing (avsec) route group so it inherits the existing
 * AppSidebar/nav chrome (app/(avsec)/avsec/layout.tsx) rather than
 * duplicating it.
 *
 * Additive, non-disruptive by design:
 * - A profile with zero active Phase 3 role assignments (every production
 *   user today) is redirected to the EXISTING legacy dashboard, unchanged.
 *   This route never activates production hierarchy or migrates anyone.
 * - A profile with multiple active assignments must explicitly choose one
 *   (?context=<key>) -- assignments are never silently merged.
 * - Only the international tier and the Operation Manager role get a
 *   dedicated Phase 7 dashboard in this pass; every other role/tier falls
 *   back to the existing legacy dashboard unchanged (documented as a known
 *   limitation in the Phase 7 report, not silently dropped).
 */
export default async function DashboardEntryPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();

  const { assignments, active } = await resolveDashboardContext(searchParams.context ?? null);

  if (assignments.length === 0) {
    redirect(landingPathForRole(profile.role));
  }

  if (!active) {
    return (
      <div className="p-4 max-w-2xl mx-auto">
        <ContextSelector assignments={assignments} />
      </div>
    );
  }

  const tier = tierForRoleCode(active.roleCode);

  if (tier === "international" && active.roleCode !== "super_admin") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <ExecutiveDashboard context={active} />
      </div>
    );
  }

  if (tier === "malaysia_leadership" && active.roleCode === "operation_manager") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <OperationManagerDashboard />
      </div>
    );
  }

  // Super Admin, and every role/tier without a dedicated Phase 7 dashboard
  // yet, falls back to the existing legacy dashboard unchanged -- see the
  // Phase 7 report's Known Limitations section for the full list.
  redirect(landingPathForRole(profile.role));
}
