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
 * Once a transaction is COMPLETED/ESCALATED (no next step), ownership
 * follows each route's actual FINALIZING checkpoint (lib/icms/workflow.ts),
 * confirmed against the real operational flow diagram (Warehouse and
 * SRA/FOB Warehouse are both IFC territory, same as Post 2 — not Operation,
 * despite sitting physically downstream of Post 6/REDQ):
 *   - HUB finalizes at Part Hub (hub_avsec) -> hub_avsec.
 *   - MAINTENANCE finalizes at Part C (post6_avsec) -> operation_avsec —
 *     GSE Workshop has no security checkpoint of its own, so the route
 *     terminates at Post 6, unlike every other outbound route.
 *   - AIRCRAFT, REDQ, and INBOUND (route is always "AIRCRAFT" on inbound)
 *     all finalize at a receiver/post2_avsec checkpoint (Part D or the
 *     final Part B) -> ifc_avsec, since that delivery point is SRA/FOB
 *     Warehouse — IFC's, not Operation's, even on the REDQ route where the
 *     transaction passed through Post 6 immediately beforehand.
 */
export function opsGroupForTransaction(
  direction: Direction,
  status: TransactionStatus,
  route: TransactionRoute
): OpsGroup | null {
  const next = nextStepFor(direction, status, route);
  if (next) return opsGroupForCheckpointRole(next.role) ?? "ifc_avsec";
  if (route === "HUB") return "hub_avsec";
  if (route === "MAINTENANCE") return "operation_avsec";
  return "ifc_avsec";
}
