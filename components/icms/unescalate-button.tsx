"use client";

import { useActionState, useState } from "react";
import { unescalateTransaction } from "@/lib/icms/actions/transactions";
import type { ActionState } from "@/lib/icms/actions/transactions";
import { Button } from "@/components/icms/ui/button";
import { Textarea } from "@/components/icms/ui/textarea";
import { Label } from "@/components/icms/ui/label";
import { ShieldCheck, X, AlertCircle } from "lucide-react";

const initialState: ActionState = { error: null };

interface UnescalateButtonProps {
  transactionId: string;
  transactionNumber?: string;
  variant?: "default" | "secondary" | "outline";
  size?: "default" | "sm" | "lg";
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
}

export function UnescalateButton({
  transactionId,
  transactionNumber,
  variant = "default",
  size = "lg",
  disabled = false,
  disabledReason,
  className,
}: UnescalateButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, formAction, pending] = useActionState(unescalateTransaction, initialState);

  if (disabled) {
    return (
      <div className="inline-block" title={disabledReason}>
        <Button
          variant="outline"
          size={size}
          disabled
          className={className}
        >
          <ShieldCheck className="mr-1.5 h-4 w-4" />
          Release Transaction
        </Button>
        {disabledReason ? (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {disabledReason}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setIsOpen(true)}
        className={`bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-700 dark:hover:bg-emerald-800 ${className ?? ""}`}
      >
        <ShieldCheck className="mr-1.5 h-4 w-4" />
        Release Transaction
      </Button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget && !pending) setIsOpen(false);
          }}
        >
          <div className="relative w-full max-w-lg rounded-xl border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              disabled={pending}
              className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 disabled:pointer-events-none"
            >
              <X className="h-5 w-5" />
              <span className="sr-only">Close</span>
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Release / Un-escalate Transaction</h2>
                {transactionNumber ? (
                  <p className="font-mono text-xs text-muted-foreground">
                    {transactionNumber}
                  </p>
                ) : null}
              </div>
            </div>

            <p className="text-sm text-muted-foreground mb-4">
              This will un-escalate the transaction and restore it to its active checkpoint progression stage, allowing operations and delivery to proceed.
            </p>

            {state?.error ? (
              <div className="mb-4 flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{state.error}</span>
              </div>
            ) : null}

            <form action={formAction} className="space-y-4">
              <input type="hidden" name="transaction_id" value={transactionId} />

              <div className="space-y-2">
                <Label htmlFor="release-notes">
                  Release / Resolution Notes <span className="text-muted-foreground font-normal">(Optional)</span>
                </Label>
                <Textarea
                  id="release-notes"
                  name="notes"
                  placeholder="e.g. Incident verified and cleared by enforcement; seals confirmed valid."
                  rows={3}
                  disabled={pending}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={pending}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-700 dark:hover:bg-emerald-800"
                >
                  {pending ? "Releasing..." : "Confirm Release"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
