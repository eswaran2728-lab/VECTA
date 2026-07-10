import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { WORKFLOWS } from "@/lib/workflow";
import type { Direction, TransactionStatus } from "@/lib/database.types";
import { cn } from "@/lib/utils";

interface WorkflowStepperProps {
  direction: Direction;
  status: TransactionStatus;
  /** Presence of each part record; Part A always exists once created. */
  parts: { part_b: boolean; part_c: boolean; part_d: boolean };
  className?: string;
}

/**
 * Direction-aware progress stepper.
 * OUTBOUND renders A -> B -> C -> D; INBOUND renders A -> C -> B (final).
 */
export function WorkflowStepper({ direction, status, parts, className }: WorkflowStepperProps) {
  const steps = [
    { key: "part_a", shortLabel: "A · Warehouse", done: true, current: false },
    ...WORKFLOWS[direction].map((s) => ({
      key: s.part,
      shortLabel: s.shortLabel,
      done: parts[s.part],
      current: !parts[s.part] && status === s.requiredStatus,
    })),
  ];

  return (
    <div className={cn("space-y-2", className)}>
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-2 text-sm">
          <span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
          {step.done ? (
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          ) : (
            <CircleDashed
              className={cn(
                "h-5 w-5 shrink-0",
                step.current ? "text-blue-600" : "text-muted-foreground/30"
              )}
            />
          )}
          <span
            className={cn(
              step.done && "font-medium",
              step.current && "font-semibold text-blue-700 dark:text-blue-300",
              !step.done && !step.current && "text-muted-foreground"
            )}
          >
            {step.shortLabel}
            {step.current ? " — next" : ""}
          </span>
        </div>
      ))}
      {status === "ESCALATED" ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-red-100 p-2 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
          <AlertTriangle className="h-5 w-5" />
          Escalated — supervisor review required.
        </div>
      ) : null}
    </div>
  );
}
