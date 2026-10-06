"use client";

import { useActionState, useState } from "react";
import { createVendorTransaction, type ActionState } from "@/lib/icms/actions/vendor-transactions";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";
import { Input } from "@/components/icms/ui/input";
import { Label } from "@/components/icms/ui/label";
import { SignatureField } from "@/components/icms/signature-pad";
import { VENDOR_DELIVERY_STATIONS } from "@/lib/caterlink/vendor";

const initialState: ActionState = { error: null };

export function VendorPartAForm() {
  const [state, formAction, pending] = useActionState(createVendorTransaction, initialState);
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="station_code">Delivery Station</Label>
            <select
              id="station_code"
              name="station_code"
              required
              defaultValue=""
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="" disabled>
                Select the station
              </option>
              {VENDOR_DELIVERY_STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="driver_name">Driver Name</Label>
            <Input id="driver_name" name="driver_name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="nric_number">NRIC Number</Label>
            <Input id="nric_number" name="nric_number" className="font-mono" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vehicle_registration_no">Vehicle Registration No</Label>
            <Input id="vehicle_registration_no" name="vehicle_registration_no" className="font-mono" autoCapitalize="characters" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="seal_number">Seal Number</Label>
            <Input id="seal_number" name="seal_number" className="font-mono" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supplies_description">Supplies (optional)</Label>
            <Input id="supplies_description" name="supplies_description" />
          </div>

          <SignatureField label="Vendor Driver Signature" onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button type="submit" size="xl" className="w-full" disabled={pending || !signature}>
            {pending ? "Creating…" : "Create Delivery"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
