import { stepsFor, type CheckpointPart } from "./workflow";
import type { Direction, TransactionRoute } from "./database.types";

/**
 * Which movement routes can actually be completed today.
 *
 * A route is completable only if every step of its state machine (lib/icms/workflow.ts) has a verified write path:
 *   - Part B: record_caterlink_part_b_secure();
 *   - Part Hub: served by the destination receipt, which needs a TRUSTED destination (only the HUB route stores one at creation).
 * Part C, Part D and Part REDQ have no write path, so a route that needs one of them stops before COMPLETED. This is a KNOWN FUNCTIONAL
 * BLOCKER, recorded here so the creation form and action do not offer a movement that can never finish, and so a readiness test
 * (tests/route-readiness.test.mts) fails visibly the day a writer for those steps appears. Nothing here invents a Part C design: the
 * open questions for the process owner are in docs/dashboard-review/part-c-owner-questions.md.
 */
export const WRITE_PATH_PARTS: readonly CheckpointPart[] = ["part_b"];
export const RECEIPT_SERVED_PARTS: readonly CheckpointPart[] = ["part_hub"];
/** Routes whose creation stores a trusted destination (hub_destination + destination station), which the receipt requires. */
const DESTINATION_BOUND_ROUTES: readonly TransactionRoute[] = ["HUB"];

export interface RouteReadiness {
  direction: Direction;
  route: TransactionRoute;
  completable: boolean;
  /** Human reason shown to officers/drivers when the route is unavailable. */
  blocker: string | null;
}

export function movementCompletable(direction: Direction, route: TransactionRoute): boolean {
  for (const step of stepsFor(direction, route)) {
    const served = WRITE_PATH_PARTS.includes(step.part) || (RECEIPT_SERVED_PARTS.includes(step.part) && DESTINATION_BOUND_ROUTES.includes(route));
    if (!served) return false;
  }
  return true;
}

const ROUTES: [Direction, TransactionRoute][] = [["OUTBOUND", "AIRCRAFT"], ["OUTBOUND", "HUB"], ["OUTBOUND", "REDQ"], ["OUTBOUND", "MAINTENANCE"], ["INBOUND", "AIRCRAFT"]];

const PART_NAMES: Record<CheckpointPart, string> = { part_b: "Part B", part_c: "Part C", part_d: "Part D", part_hub: "Part Hub", part_redq: "Part REDQ" };

export const ROUTE_READINESS: readonly RouteReadiness[] = ROUTES.map(([direction, route]) => {
  const completable = movementCompletable(direction, route);
  const missing = stepsFor(direction, route).find((s) => !WRITE_PATH_PARTS.includes(s.part) && !(RECEIPT_SERVED_PARTS.includes(s.part) && DESTINATION_BOUND_ROUTES.includes(route)));
  return {
    direction,
    route,
    completable,
    blocker: completable || !missing ? null : `${PART_NAMES[missing.part]} has no recording workflow yet — this movement cannot be completed. Awaiting the CaterLink process owner's design.`,
  };
});

export const KNOWN_BLOCKERS = [
  {
    id: "PART_C_NO_WRITE_PATH",
    summary: "Parts C, D and REDQ have no write path, so AIRCRAFT, REDQ, INBOUND and MAINTENANCE movements cannot reach COMPLETED. Only the HUB route can complete.",
    ownerQuestions: "docs/dashboard-review/part-c-owner-questions.md",
  },
] as const;

export function routeBlocker(direction: Direction, route: TransactionRoute): string | null {
  return ROUTE_READINESS.find((r) => r.direction === direction && r.route === route)?.blocker ?? null;
}
