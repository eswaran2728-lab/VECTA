"use client";

import { useActionState, useState } from "react";
import { completePartHub, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";

const initialState: ActionState = { error: null };

interface PartHubFormProps {
  transactionId: string;
  destinationLabel: string;
  hubAvsecName: string;
  hubAvsecStaffId: string;
}

/**
 * Confirmed destination is never a form field — it's derived server-side
 * from the transaction's own hub_destination (completePartHub), shown here
 * read-only so there's no way to submit a mismatched destination.
 */
export function PartHubForm({
  transactionId,
  destinationLabel,
  hubAvsecName,
  hubAvsecStaffId,
}: PartHubFormProps) {
  const [state, formAction, pending] = useActionState(completePartHub, initialState);
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="transaction_id" value={transactionId} />

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Confirming delivery to:</span>{" "}
              <span className="font-semibold">{destinationLabel}</span>
            </p>
            <p className="mt-1">
              <span className="text-muted-foreground">Hub AVSEC:</span>{" "}
              <span className="font-medium">{hubAvsecName}</span>{" "}
              <span className="text-muted-foreground">({hubAvsecStaffId})</span>
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <SignatureField label="Hub AVSEC Signature" onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" size="xl" className="w-full" disabled={pending || !signature}>
            {pending ? "Confirming…" : "Confirm Delivery & Complete"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
