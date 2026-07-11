"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { completePartD, type ActionState } from "@/lib/actions/transactions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BigCheckbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { SealVerifyFields } from "@/components/seal-verify-fields";
import { formDataToPayload, queueSubmission } from "@/lib/offline-queue";
import { DELIVERY_LOCATION_LABELS } from "@/lib/constants";
import type { Seal, Transaction } from "@/lib/database.types";

const initialState: ActionState = { error: null };

export function PartDForm({
  transaction,
  seals,
  receiverName,
  receiverStaffId,
}: {
  transaction: Transaction;
  seals: Pick<Seal, "id" | "seal_type" | "seal_color">[];
  receiverName: string;
  receiverStaffId: string;
}) {
  const [state, formAction, pending] = useActionState(completePartD, initialState);
  const [sealIntact, setSealIntact] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);

  const allSealsEntered = seals.every((s) => (entries[s.id] ?? "").trim() !== "");

  const handleOffline = (e: React.FormEvent<HTMLFormElement>) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      void queueSubmission("part_d", formDataToPayload(e.currentTarget)).then(() =>
        setQueuedMsg(
          "Offline — this delivery confirmation is saved on the device and will sync automatically when the connection returns."
        )
      );
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Vehicle</p>
            <p className="font-mono text-lg font-bold">{transaction.vehicle_number}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Driver</p>
            <p className="text-lg font-bold">{transaction.driver_name}</p>
          </div>
        </div>

        <form action={formAction} onSubmit={handleOffline} className="space-y-4">
          <input type="hidden" name="transaction_id" value={transaction.id} />
          <input type="hidden" name="seal_entries" value={JSON.stringify(entries)} />

          <div className="space-y-2">
            <Label htmlFor="delivery_location">Delivery Location</Label>
            <Select id="delivery_location" name="delivery_location" required defaultValue="">
              <option value="" disabled>
                Select location…
              </option>
              {Object.entries(DELIVERY_LOCATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          <SealVerifyFields seals={seals} entries={entries} onChange={setEntries} />

          <BigCheckbox
            id="seal_intact"
            name="seal_intact"
            label="Seals intact on arrival"
            description="No cuts, tampering or re-sealing visible on any seal."
            checked={sealIntact}
            onCheckedChange={setSealIntact}
          />

          <div className="space-y-2">
            <Label htmlFor="remarks">Remarks (optional)</Label>
            <Textarea id="remarks" name="remarks" rows={2} />
          </div>

          <div className="rounded-md bg-muted p-3 text-sm">
            <p>
              <span className="text-muted-foreground">Receiver:</span>{" "}
              <span className="font-medium">{receiverName}</span>{" "}
              <span className="text-muted-foreground">({receiverStaffId})</span>
            </p>
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          {queuedMsg ? (
            <p className="rounded-md bg-amber-100 p-3 text-sm font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              {queuedMsg}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="xl"
              className="w-full"
              disabled={pending || !sealIntact || !allSealsEntered || !signature}
            >
              {pending ? "Saving…" : "Confirm Delivery — Complete"}
            </Button>
            <Link href={`/transactions/${transaction.id}/incident`} className="w-full">
              <Button type="button" variant="destructive" size="lg" className="w-full">
                Seal problem — Report Incident
              </Button>
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
