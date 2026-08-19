"use client";

import { useActionState, useState } from "react";
import { submitVendorPartB, type ActionState } from "@/lib/actions/vendor-transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";

const initialState: ActionState = { error: null };

interface VendorPartBFormProps {
  transactionId: string;
  officerName: string;
  officerStaffId: string;
}

/**
 * Officer types what they physically observe — no auto-fill from Part A,
 * matching the catering checkpoint forms' deliberate design.
 */
export function VendorPartBForm({ transactionId, officerName, officerStaffId }: VendorPartBFormProps) {
  const [state, formAction, pending] = useActionState(submitVendorPartB, initialState);
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="transaction_id" value={transactionId} />

          <div className="space-y-2">
            <Label htmlFor="vehicle_registration_no">Vehicle Registration No</Label>
            <Input
              id="vehicle_registration_no"
              name="vehicle_registration_no"
              placeholder="e.g. WKD 4521"
              autoCapitalize="characters"
              className="font-mono"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="driver_name">Driver Name</Label>
            <Input id="driver_name" name="driver_name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="driver_nric">Driver NRIC</Label>
            <Input id="driver_nric" name="driver_nric" className="font-mono" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="seal_number">Seal Number</Label>
            <Input id="seal_number" name="seal_number" className="font-mono" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">ASO:</span>{" "}
              <span className="font-medium">{officerName}</span>{" "}
              <span className="text-muted-foreground">({officerStaffId})</span>
            </p>
          </div>

          <SignatureField label="ASO Signature" onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" size="xl" className="w-full" disabled={pending || !signature}>
            {pending ? "Saving…" : "Approve Part B"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
