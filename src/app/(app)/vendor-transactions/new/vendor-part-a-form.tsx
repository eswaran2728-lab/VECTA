"use client";

import { useActionState, useState } from "react";
import { createVendorTransaction, type ActionState } from "@/lib/actions/vendor-transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignatureField } from "@/components/signature-pad";

const initialState: ActionState = { error: null };

export function VendorPartAForm() {
  const [state, formAction, pending] = useActionState(createVendorTransaction, initialState);
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="driver_name">Driver Name</Label>
            <Input id="driver_name" name="driver_name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nric_number">NRIC Number</Label>
            <Input id="nric_number" name="nric_number" className="font-mono" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="seal_number">Seal Number</Label>
            <Input id="seal_number" name="seal_number" className="font-mono" required />
          </div>

          <SignatureField label="Vendor Driver Signature" onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" size="xl" className="w-full" disabled={pending || !signature}>
            {pending ? "Creating…" : "Create Delivery & Generate QR"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
