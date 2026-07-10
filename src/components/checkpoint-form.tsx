"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  completePartB,
  completePartC,
  type ActionState,
} from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import type { Transaction } from "@/lib/database.types";

const initialState: ActionState = { error: null };

interface CheckpointFormProps {
  part: "part_b" | "part_c";
  transaction: Transaction;
  officerName: string;
  officerStaffId: string;
  /** True when this checkpoint is the final step (inbound Part B). */
  finalizes?: boolean;
}

/**
 * Shared Part B / Part C verification form. Fast path: three taps on the
 * checklist + signature + one submit tap.
 */
export function CheckpointForm({
  part,
  transaction,
  officerName,
  officerStaffId,
  finalizes = false,
}: CheckpointFormProps) {
  const action = part === "part_b" ? completePartB : completePartC;
  const [state, formAction, pending] = useActionState(action, initialState);
  const [vehicle, setVehicle] = useState(false);
  const [driver, setDriver] = useState(false);
  const [seal, setSeal] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  const allChecked = vehicle && driver && seal;

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        {/* What the officer must verify against the physical vehicle */}
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Vehicle</p>
            <p className="font-mono text-lg font-bold">{transaction.vehicle_number}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Driver</p>
            <p className="text-lg font-bold">{transaction.driver_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Driver ID</p>
            <p className="font-mono text-lg font-bold">{transaction.driver_id}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Seal</p>
            <p className="font-mono text-lg font-bold">{transaction.seal_number}</p>
          </div>
        </div>

        <form action={formAction} className="space-y-4">
          <input type="hidden" name="transaction_id" value={transaction.id} />

          <div className="space-y-3">
            <BigCheckbox
              id="vehicle_verified"
              name="vehicle_verified"
              label="Vehicle verified"
              description="Plate matches the record above."
              checked={vehicle}
              onCheckedChange={setVehicle}
            />
            <BigCheckbox
              id="driver_verified"
              name="driver_verified"
              label="Driver verified"
              description="ID document matches name and driver ID."
              checked={driver}
              onCheckedChange={setDriver}
            />
            <BigCheckbox
              id="seal_verified"
              name="seal_verified"
              label="Seal verified"
              description="Seal intact and number matches the record."
              checked={seal}
              onCheckedChange={setSeal}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Officer:</span>{" "}
              <span className="font-medium">{officerName}</span>{" "}
              <span className="text-muted-foreground">({officerStaffId})</span>
            </p>
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="xl"
              className="w-full"
              disabled={pending || !allChecked || !signature}
            >
              {pending ? "Saving…" : finalizes ? "Approve & Complete Transaction" : "Approve & Release"}
            </Button>
            <Link href={`/transactions/${transaction.id}/incident`} className="w-full">
              <Button type="button" variant="destructive" size="lg" className="w-full">
                Verification failed — Report Incident
              </Button>
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
