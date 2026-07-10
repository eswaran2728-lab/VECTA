"use client";

import { useActionState, useState } from "react";
import { createTransaction, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { SealEditor, type SealDraft } from "@/components/seal-editor";
import { DIRECTION_TRUCK_SEAL_COLOR } from "@/lib/constants";
import type { Direction } from "@/lib/database.types";

const initialState: ActionState = { error: null };

interface PartAFormProps {
  picName: string;
  picStaffId: string;
  /** Fixed by the creator's role: warehouse_pic = OUTBOUND, sra_warehouse_pic = INBOUND. */
  direction: Direction;
}

export function PartAForm({ picName, picStaffId, direction }: PartAFormProps) {
  const [state, formAction, pending] = useActionState(createTransaction, initialState);
  const [searchDone, setSearchDone] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [seals, setSeals] = useState<SealDraft[]>([
    { seal_number: "", seal_type: "TRUCK_SEAL", seal_color: DIRECTION_TRUCK_SEAL_COLOR[direction] },
  ]);

  const sealsReady = seals.length > 0 && seals.every((s) => s.seal_number.trim() !== "");

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="direction" value={direction} />

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
              <Label htmlFor="driver_name">Driver Name</Label>
              <Input id="driver_name" name="driver_name" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver_id">Driver ID</Label>
              <Input id="driver_id" name="driver_id" required />
            </div>
          </div>

          <SealEditor direction={direction} seals={seals} onChange={setSeals} />
          <input type="hidden" name="seals" value={JSON.stringify(seals)} />

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
            disabled={pending || !searchDone || !signature || !sealsReady}
          >
            {pending ? "Creating…" : "Create Transaction & Generate QR"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
