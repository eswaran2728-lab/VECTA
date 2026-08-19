import { nextStepFor } from "./workflow";
import type { Direction, OpsGroup, Role, TransactionRoute, TransactionStatus } from "./database.types";

/**
 * Checkpoint role -> ops_group. Matches the duty_post -> ops_group mapping
 * in supabase/migrations/team_based_ops_groups.sql exactly (Post 2 ->
 * ifc_avsec; Post 6 + REDQ -> operation_avsec; Hub -> hub_avsec). Roles with
 * no single owning ops_group (receiver, warehouse_pic — both obsolete/
 * moving to CaterLink — plus the org-wide supervisor/enforcement/vendor)
 * return null rather than guessing.
 */
export function opsGroupForCheckpointRole(role: Role): OpsGroup | null {
  if (role === "post2_avsec") return "ifc_avsec";
  if (role === "post6_avsec" || role === "redq_avsec") return "operation_avsec";
  if (role === "hub_avsec") return "hub_avsec";
  return null;
}

/**
 * Which ops_group a transaction currently belongs to, for the scan
 * ops_group scope check.
 *
 * While a transaction is in progress, it belongs to whichever checkpoint
 * it's currently waiting on (nextStepFor's role, mapped above) — this is
 * unambiguous.
 *
 * Once a transaction is COMPLETED/ESCALATED (no next step), a HUB-route
 * transaction is still unambiguous (hub_avsec is its only real checkpoint
 * besides Part B), and a REDQ-route transaction is attributed to
 * operation_avsec (its last active AVSEC checkpoint before the deprecated
 * receiver/Part D step). A finished plain AIRCRAFT- or MAINTENANCE-route
 * transaction, however, has touched BOTH post2_avsec (ifc_avsec) and
 * post6_avsec (operation_avsec) checkpoints over its lifetime with no
 * single owning group — this returns null (unmappable) rather than
 * guessing; see the merge report for this gap.
 */
export function opsGroupForTransaction(
  direction: Direction,
  status: TransactionStatus,
  route: TransactionRoute
): OpsGroup | null {
  const next = nextStepFor(direction, status, route);
  if (next) return opsGroupForCheckpointRole(next.role);
  if (route === "HUB") return "hub_avsec";
  if (route === "REDQ") return "operation_avsec";
  return null;
}
