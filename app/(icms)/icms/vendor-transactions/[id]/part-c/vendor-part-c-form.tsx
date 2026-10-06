"use client";

import { useActionState, useState } from "react";
import { submitVendorPartC, type ActionState } from "@/lib/icms/actions/vendor-transactions";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/icms/ui/card";
import { SignatureField } from "@/components/icms/signature-pad";

const initialState: ActionState = { error: null };

interface VendorPartCFormProps {
  transactionId: string;
  vendorDriverName: string;
}

export function VendorPartCForm({ transactionId, vendorDriverName }: VendorPartCFormProps) {
  const [state, formAction, pending] = useActionState(submitVendorPartC, initialState);
  const [vendorSignature, setVendorSignature] = useState<string | null>(null);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="transaction_id" value={transactionId} />
      <input type="hidden" name="vendor_signature" value={vendorSignature ?? ""} />

      <Card className="border-lime-300 dark:border-lime-800">
        <CardHeader>
          <CardTitle className="text-base">Vendor Driver — {vendorDriverName}</CardTitle>
        </CardHeader>
        <CardContent>
          <SignatureField label="Vendor Driver Signature" onChange={setVendorSignature} />
        </CardContent>
      </Card>

      {state.error ? (
        <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" size="xl" className="w-full" disabled={pending || !vendorSignature}>
        {pending ? "Completing…" : "Complete Delivery"}
      </Button>
    </form>
  );
}
