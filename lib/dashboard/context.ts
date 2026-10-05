import { createClient } from "@/lib/supabase/server";
import { assignmentKey, type RoleAssignmentContext } from "@/lib/dashboard/tiers";
import { assignmentsFromRpcRows } from "@/lib/auth/canonical-access";

export type { RoleAssignmentContext, DashboardTier } from "@/lib/dashboard/tiers";
export { assignmentKey, tierForRoleCode } from "@/lib/dashboard/tiers";

/**
 * Phase 7 dashboard-context resolution.
 *
 * Wraps the pre-existing Phase 3 RPC get_my_active_role_assignments() --
 * introduces no new authorization logic of its own. Scope always comes from
 * the caller's own active role assignments (server-side, RLS/RPC-enforced),
 * never from anything the browser supplies.
 *
 * Additive by design: a profile with zero Phase 3 assignments (true for
 * every production user today) gets an empty array here, and callers of
 * this module are expected to fall back to the existing legacy dashboard
 * unchanged in that case -- this module never redirects or renders on its
 * own.
 */

/** Returns the caller's own currently-active Phase 3 role assignments.
 *  Empty array means "no Phase 3 hierarchy access" -- the caller must fall
 *  back to the legacy dashboard, not treat this as an error. */
export async function getActiveRoleAssignments(): Promise<RoleAssignmentContext[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_active_role_assignments");
  if (error || !data) return [];
  return assignmentsFromRpcRows(data);
}

/**
 * Resolves which single assignment context the dashboard should render for
 * this request.
 *
 * - Zero assignments -> null (caller falls back to the legacy dashboard).
 * - One assignment -> that assignment, no selection needed.
 * - Multiple assignments -> the one matching `selectedKey` (from an
 *   explicit user choice, e.g. a query param), or null if none is selected
 *   yet or the selection no longer matches an active assignment -- callers
 *   must then show the context-selection UI. Multiple assignments are NEVER
 *   silently merged or auto-picked.
 */
export async function resolveDashboardContext(
  selectedKey: string | null,
): Promise<{ assignments: RoleAssignmentContext[]; active: RoleAssignmentContext | null }> {
  const assignments = await getActiveRoleAssignments();
  if (assignments.length === 0) return { assignments, active: null };
  if (assignments.length === 1) return { assignments, active: assignments[0] };
  const active = selectedKey ? (assignments.find((a) => assignmentKey(a) === selectedKey) ?? null) : null;
  return { assignments, active };
}
