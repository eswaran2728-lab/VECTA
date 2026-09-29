import { redirect } from "next/navigation";
import { requireProfile, landingPathForRole } from "@/lib/avsec/auth";
import { resolveDashboardContext } from "@/lib/dashboard/context";
import { ContextSelector } from "@/components/dashboard/ContextSelector";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";
import { OperationManagerDashboard } from "@/components/dashboard/OperationManagerDashboard";
import { EntityDashboard } from "@/components/dashboard/EntityDashboard";
import { EntityAdminDashboard } from "@/components/dashboard/EntityAdminDashboard";
import { SuperAdminDashboard } from "@/components/dashboard/SuperAdminDashboard";
import { GenericLinkHubDashboard } from "@/components/dashboard/GenericLinkHubDashboard";
import { LINK_HUB_CONFIG } from "@/lib/dashboard/linkHubConfig";

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
 * - Every role dispatched below composes existing, already-secure Phase
 *   5/6/7 RPCs and existing routes -- no new authorization decision is
 *   made in this file. Any role NOT listed here (Super Admin's
 *   sub-cases aside) falls back to the legacy dashboard -- see the Phase 7
 *   closure report for the exact classification of every Phase 3 role.
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

  const roleCode = active.roleCode;

  if (roleCode === "airasia_management" || roleCode === "ghod") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <ExecutiveDashboard context={active} />
      </div>
    );
  }

  if (roleCode === "super_admin") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <SuperAdminDashboard />
      </div>
    );
  }

  if (roleCode === "maa_boss" || roleCode === "aax_boss") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <EntityDashboard context={active} />
      </div>
    );
  }

  if (roleCode === "maa_admin" || roleCode === "aax_admin") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <EntityAdminDashboard context={active} />
      </div>
    );
  }

  if (roleCode === "operation_manager") {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <OperationManagerDashboard />
      </div>
    );
  }

  const linkHubConfig = LINK_HUB_CONFIG[roleCode];
  if (linkHubConfig) {
    return (
      <div className="p-4 max-w-4xl mx-auto">
        <GenericLinkHubDashboard context={active} {...linkHubConfig} />
      </div>
    );
  }

  // Every role without a dedicated Phase 7 dashboard above falls back to
  // the existing legacy dashboard unchanged -- see the Phase 7 closure
  // report's classification for exactly which roles this affects (none,
  // as of this pass, for any currently-defined Phase 3 role -- this branch
  // exists for forward compatibility with a future role_definitions row).
  redirect(landingPathForRole(profile.role));
}
