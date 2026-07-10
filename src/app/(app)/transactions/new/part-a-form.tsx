"use client";

import { useActionState, useState } from "react";
import { createTransaction, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { DIRECTION_LABELS } from "@/lib/constants";

const initialState: ActionState = { error: null };

export function PartAForm({ picName, picStaffId }: { picName: string; picStaffId: string }) {
  const [state, formAction, pending] = useActionState(createTransaction, initialState);
  const [searchDone, setSearchDone] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="direction">Direction</Label>
            <Select id="direction" name="direction" required defaultValue="WAREHOUSE_TO_AIRCRAFT">
              {Object.entries(DIRECTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="vehicle_number">Vehicle Number</Label>
              <Input
                id="vehicle_number"
                name="vehicle_number"
                placeholder="e.g. WKD 4521"
                autoCapitalize="characters"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seal_number">Seal Number</Label>
              <Input id="seal_number" name="seal_number" placeholder="e.g. SEAL-48213" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_name">Driver Name</Label>
              <Input id="driver_name" name="driver_name" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_id">Driver ID</Label>
              <Input id="driver_id" name="driver_id" required />
            </div>
          </div>

          <BigCheckbox
            id="vehicle_search_completed"
            name="vehicle_search_completed"
            label="Vehicle search completed"
            description="Cab, cargo area and undercarriage inspected before sealing."
            checked={searchDone}
            onCheckedChange={setSearchDone}
            required
          />

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">PIC:</span>{" "}
              <span className="font-medium">{picName}</span>{" "}
              <span className="text-muted-foreground">({picStaffId})</span>
            </p>
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <Button
            type="submit"
            size="xl"
            className="w-full"
            disabled={pending || !searchDone || !signature}
          >
            {pending ? "Creating…" : "Create Transaction & Generate QR"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
