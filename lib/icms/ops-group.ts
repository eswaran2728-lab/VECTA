import { nextStepFor } from "./workflow.ts";
import type { Direction, OpsGroup, Role, TransactionRoute, TransactionStatus } from "./database.types";

/**
 * Checkpoint role -> ops_group. Matches the duty_post -> ops_group mapping
 * in supabase/migrations/team_based_ops_groups.sql exactly (Post 2 ->
 * ifc_avsec; Post 6 + REDQ -> operation_avsec; Hub -> hub_avsec). Receiver
 * (Part D) has no duty_post/ops_group of its own — per the project owner's
 * decision, it's now assigned to ifc_avsec (see opsGroupForTransaction).
 * warehouse_pic (obsolete/moving to CaterLink) and the org-wide
 * supervisor/enforcement/vendor still return null rather than guessing.
 */
export function opsGroupForCheckpointRole(role: Role): OpsGroup | null {
  if (role === "post2_avsec") return "ifc_avsec";
  if (role === "post6_avsec" || role === "redq_avsec") return "operation_avsec";
  if (role === "hub_avsec") return "hub_avsec";
  if (role === "receiver") return "ifc_avsec";
  return null;
}

/**
 * Which ops_group a transaction currently belongs to, for the scan
 * ops_group scope check.
 *
 * While a transaction is in progress, it belongs to whichever checkpoint
 * it's currently waiting on (nextStepFor's role, mapped above) — this is
 * unambiguous, including at Receiver/Part D (see opsGroupForCheckpointRole).
 *
 * Once a transaction is COMPLETED/ESCALATED (no next step), a HUB-route
 * transaction is still unambiguous (hub_avsec is its only real checkpoint
 * besides Part B), and a REDQ-route transaction is attributed to
 * operation_avsec (its last active AVSEC checkpoint before the deprecated
 * receiver/Part D step). A finished plain AIRCRAFT- or MAINTENANCE-route
 * transaction has touched BOTH post2_avsec (ifc_avsec) and post6_avsec
 * (operation_avsec) checkpoints over its lifetime with no single
 * unambiguous owning group — per the project owner's decision, these
 * (and the in-progress Receiver/Part D case above) are now assigned to
 * ifc_avsec rather than left unmappable: IFC AVSEC staff can scan them,
 * Operation AVSEC staff cannot (org-wide roles bypass this check entirely,
 * unchanged).
 */
export function opsGroupForTransaction(
  direction: Direction,
  status: TransactionStatus,
  route: TransactionRoute
): OpsGroup | null {
  const next = nextStepFor(direction, status, route);
  if (next) return opsGroupForCheckpointRole(next.role) ?? "ifc_avsec";
  if (route === "HUB") return "hub_avsec";
  if (route === "REDQ") return "operation_avsec";
  return "ifc_avsec";
}
