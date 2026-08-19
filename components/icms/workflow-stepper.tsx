import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { stepsFor, type CheckpointPart } from "@/lib/icms/workflow";
import type { Direction, TransactionRoute, TransactionStatus } from "@/lib/icms/database.types";
import { cn } from "@/lib/icms/utils";

interface WorkflowStepperProps {
  direction: Direction;
  status: TransactionStatus;
  route?: TransactionRoute;
  /** Presence of each part record; Part A always exists once created. */
  parts: Record<CheckpointPart, boolean>;
  className?: string;
}

/**
 * Direction- and route-aware progress stepper. Pulls the step list from
 * stepsFor() rather than hardcoding it, so the stepper and the actual
 * enforced sequence can never drift apart. AIRCRAFT (default) renders
 * A -> B -> C -> D; HUB renders A -> B -> Hub (terminal); REDQ renders
 * A -> B -> REDQ -> C -> D; INBOUND renders A -> C -> B (final).
 */
export function WorkflowStepper({
  direction,
  status,
  route = "AIRCRAFT",
  parts,
  className,
}: WorkflowStepperProps) {
  const steps = [
    { key: "part_a", shortLabel: "A · Warehouse", done: true, current: false },
    ...stepsFor(direction, route).map((s) => ({
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
        <div className="mt-2 flex items-center gap-2 rounded-md bg-orange-100 p-2 text-sm text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
          <AlertTriangle className="h-5 w-5" />
          Escalated — admin review required.
        </div>
      ) : null}
    </div>
  );
}
