import type { Direction, Role, TransactionStatus } from "./database.types";

/**
 * Single source of truth for the direction-aware checkpoint sequence.
 * Mirrored in the database by the enforce_part_sequence() trigger
 * (supabase/migrations/20260201000001_phase1_direction_aware.sql).
 *
 * OUTBOUND (departure, BLUE seal):  A -> B (In-flight Post) -> C (Airport Post) -> D
 * INBOUND  (arrival,  GREEN seal):  A -> C (Airport Post)  -> B (In-flight Post, FINAL)
 */

export type CheckpointPart = "part_b" | "part_c" | "part_d";

export interface CheckpointStep {
  part: CheckpointPart;
  /** URL segment under /transactions/[id]/ */
  slug: string;
  label: string;
  shortLabel: string;
  role: Role;
  requiredStatus: TransactionStatus;
  nextStatus: TransactionStatus;
  /** Completing this step completes the whole transaction. */
  finalizes: boolean;
}

const PART_B_LABEL = "Part B — In-flight Security Post (Post 2)";
const PART_C_LABEL = "Part C — Airport Security Post (Post 6)";
const PART_D_LABEL = "Part D — Delivery (SRA Warehouse / Aircraft)";

export const WORKFLOWS: Record<Direction, CheckpointStep[]> = {
  OUTBOUND: [
    {
      part: "part_b",
      slug: "part-b",
      label: PART_B_LABEL,
      shortLabel: "B · In-flight Post",
      role: "post2_avsec",
      requiredStatus: "CREATED",
      nextStatus: "INFLIGHT_POST_APPROVED",
      finalizes: false,
    },
    {
      part: "part_c",
      slug: "part-c",
      label: PART_C_LABEL,
      shortLabel: "C · Airport Post",
      role: "post6_avsec",
      requiredStatus: "INFLIGHT_POST_APPROVED",
      nextStatus: "AIRPORT_POST_APPROVED",
      finalizes: false,
    },
    {
      part: "part_d",
      slug: "part-d",
      label: PART_D_LABEL,
      shortLabel: "D · Delivery",
      role: "receiver",
      requiredStatus: "AIRPORT_POST_APPROVED",
      nextStatus: "COMPLETED",
      finalizes: true,
    },
  ],
  INBOUND: [
    {
      part: "part_c",
      slug: "part-c",
      label: PART_C_LABEL,
      shortLabel: "C · Airport Post",
      role: "post6_avsec",
      requiredStatus: "CREATED",
      nextStatus: "AIRPORT_POST_APPROVED",
      finalizes: false,
    },
    {
      part: "part_b",
      slug: "part-b",
      label: `${PART_B_LABEL} — final`,
      shortLabel: "B · In-flight Post (final)",
      role: "post2_avsec",
      requiredStatus: "AIRPORT_POST_APPROVED",
      nextStatus: "COMPLETED",
      finalizes: true,
    },
  ],
};

export function getStep(direction: Direction, part: CheckpointPart): CheckpointStep | null {
  return WORKFLOWS[direction].find((s) => s.part === part) ?? null;
}

/** The next checkpoint a transaction is waiting on, or null when finished/escalated. */
export function nextStepFor(
  direction: Direction,
  status: TransactionStatus
): CheckpointStep | null {
  if (status === "COMPLETED" || status === "ESCALATED") return null;
  return WORKFLOWS[direction].find((s) => s.requiredStatus === status) ?? null;
}

/**
 * Derive which checkpoint parts are already done purely from the status
 * (used on checkpoint screens that don't load the part records).
 * ESCALATED yields all-false; the stepper shows the escalation alert instead.
 */
export function partsDoneFromStatus(
  direction: Direction,
  status: TransactionStatus
): { part_b: boolean; part_c: boolean; part_d: boolean } {
  const done = { part_b: false, part_c: false, part_d: false };
  const progression: TransactionStatus[] = [
    "CREATED",
    ...WORKFLOWS[direction].map((s) => s.nextStatus),
  ];
  const idx = progression.indexOf(status);
  WORKFLOWS[direction].forEach((step, i) => {
    if (idx > i) done[step.part] = true;
  });
  return done;
}

/**
 * Human-readable out-of-order error (English + Bahasa Melayu),
 * or null when the checkpoint may proceed.
 */
export function checkpointOrderError(
  direction: Direction,
  part: CheckpointPart,
  status: TransactionStatus
): string | null {
  const step = getStep(direction, part);
  const dirEn = direction === "OUTBOUND" ? "outbound" : "inbound";
  const dirBm = direction === "OUTBOUND" ? "keluar" : "masuk";

  if (!step) {
    return (
      `${PART_D_LABEL} does not apply to inbound transactions. ` +
      `/ Bahagian D tidak terpakai untuk transaksi masuk.`
    );
  }
  if (status === "ESCALATED") {
    return (
      "This transaction is escalated; checkpoint processing is suspended pending admin review. " +
      "/ Transaksi ini telah dieskalasi; pemprosesan digantung sehingga semakan admin."
    );
  }
  if (status !== step.requiredStatus) {
    return (
      `Out of order: ${step.label} requires status ${step.requiredStatus}, but this ${dirEn} transaction is ${status}. ` +
      `/ Tidak mengikut urutan: ${step.label} memerlukan status ${step.requiredStatus}, tetapi transaksi ${dirBm} ini berstatus ${status}.`
    );
  }
  return null;
}
