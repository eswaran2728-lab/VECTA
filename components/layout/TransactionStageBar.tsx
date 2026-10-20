import type { TransactionStatus } from "@/lib/icms/database.types";

/**
 * Simple stepped/segmented progress indicator for a transaction's real
 * status column — only used where transactions.status already exists, not
 * an invented stage model. ESCALATED renders as its own flagged state
 * rather than a step position.
 */
const STEP_ORDER: TransactionStatus[] = [
  "CREATED",
  "INFLIGHT_POST_APPROVED",
  "AIRPORT_POST_APPROVED",
  "COMPLETED",
];

export function TransactionStageBar({ status }: { status: TransactionStatus }) {
  if (status === "ESCALATED") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-destructive">
        <span className="h-[6px] w-[6px] rounded-full bg-destructive" aria-hidden />
        Escalated
      </span>
    );
  }

  // REDQ_RESEALED sits between step 1 and 2 in the real sequence — treat it
  // as still-at-step-1 for this simplified 4-step readout.
  const effective = status === "REDQ_RESEALED" ? "INFLIGHT_POST_APPROVED" : status;
  const currentIndex = STEP_ORDER.indexOf(effective);

  return (
    <span className="inline-flex items-center gap-[3px]" role="img" aria-label={`Stage: ${status}`}>
      {STEP_ORDER.map((step, i) => (
        <span
          key={step}
          aria-hidden
          className={`h-[6px] w-[14px] rounded-full ${i <= currentIndex ? "bg-primary" : "bg-border"}`}
        />
      ))}
    </span>
  );
}
