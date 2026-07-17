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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SignatureField } from "@/components/signature-pad";
import { SealVerifyFields } from "@/components/seal-verify-fields";
import { formDataToPayload, queueSubmission } from "@/lib/offline-queue";
import { t, type Lang } from "@/lib/i18n";
import type { Seal, Transaction } from "@/lib/database.types";

const initialState: ActionState = { error: null };

interface CheckpointFormProps {
  part: "part_b" | "part_c";
  transaction: Transaction;
  seals: Pick<Seal, "id" | "seal_number" | "seal_type" | "seal_color">[];
  officerName: string;
  officerStaffId: string;
  /** True when this checkpoint is the final step (inbound Part B). */
  finalizes?: boolean;
  lang?: Lang;
}

/**
 * Shared Part B / Part C verification form. Officers must physically read and
 * enter every seal number — the numbers on record are not shown.
 */
export function CheckpointForm({
  part,
  transaction,
  seals,
  officerName,
  officerStaffId,
  finalizes = false,
  lang = "en",
}: CheckpointFormProps) {
  const action = part === "part_b" ? completePartB : completePartC;
  const [state, formAction, pending] = useActionState(action, initialState);
  const [vehicle, setVehicle] = useState(false);
  const [driver, setDriver] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);
  const [result, setResult] = useState<"PASS" | "ESCALATE">("PASS");
  const [escalationReason, setEscalationReason] = useState("");

  const malaysiaNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" })
  );
  const defaultDate = `${malaysiaNow.getFullYear()}-${String(malaysiaNow.getMonth() + 1).padStart(2, "0")}-${String(malaysiaNow.getDate()).padStart(2, "0")}`;
  const defaultTime = `${String(malaysiaNow.getHours()).padStart(2, "0")}:${String(malaysiaNow.getMinutes()).padStart(2, "0")}`;

  const allSealsEntered = seals.every(
    (s) => (entries[s.id] ?? "").trim() !== "" && (colors[s.id] ?? "").trim() !== ""
  );
  const ready =
    !!signature &&
    (result === "ESCALATE"
      ? escalationReason.trim().length > 0
      : vehicle && driver && allSealsEntered);

  const handleOffline = (e: React.FormEvent<HTMLFormElement>) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      e.preventDefault();
      void queueSubmission(part, formDataToPayload(e.currentTarget)).then(() =>
        setQueuedMsg(
          "Offline — this checkpoint is saved on the device and will sync automatically when the connection returns."
        )
      );
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        {/* What the officer must verify against the physical vehicle */}
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{t(lang, "vehicle")}</p>
            <p className="font-mono text-lg font-bold">{transaction.vehicle_number}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t(lang, "driver")}</p>
            <p className="text-lg font-bold">{transaction.driver_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t(lang, "driver_id")}</p>
            <p className="font-mono text-lg font-bold">{transaction.driver_id}</p>
          </div>
        </div>

        <form action={formAction} onSubmit={handleOffline} className="space-y-4">
          <input type="hidden" name="transaction_id" value={transaction.id} />
          <input type="hidden" name="seal_entries" value={JSON.stringify(entries)} />
          <input type="hidden" name="seal_colors" value={JSON.stringify(colors)} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="officer_name">AVSEC Officer Name</Label>
              <Input id="officer_name" name="officer_name" defaultValue={officerName} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="officer_staff_id">AVSEC ID / Badge number</Label>
              <Input id="officer_staff_id" name="officer_staff_id" defaultValue={officerStaffId} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkpoint_date">Date</Label>
              <Input id="checkpoint_date" name="checkpoint_date" type="date" defaultValue={defaultDate} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="checkpoint_time">Time</Label>
              <Input id="checkpoint_time" name="checkpoint_time" type="time" defaultValue={defaultTime} required />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="observed_vehicle_number">Vehicle / Registration</Label>
              <Input id="observed_vehicle_number" name="observed_vehicle_number" defaultValue={transaction.vehicle_number} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="observed_driver_name">Driver name</Label>
              <Input id="observed_driver_name" name="observed_driver_name" defaultValue={transaction.driver_name} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="observed_driver_id">Driver IC / ID</Label>
              <Input id="observed_driver_id" name="observed_driver_id" defaultValue={transaction.driver_id} required />
            </div>
          </div>

          <div className="space-y-3">
            <BigCheckbox
              id="vehicle_verified"
              name="vehicle_verified"
              label={t(lang, "vehicle_verified")}
              description={t(lang, "vehicle_verified_desc")}
              checked={vehicle}
              onCheckedChange={setVehicle}
            />
            <BigCheckbox
              id="driver_verified"
              name="driver_verified"
              label={t(lang, "driver_verified")}
              description={t(lang, "driver_verified_desc")}
              checked={driver}
              onCheckedChange={setDriver}
            />
          </div>

          <SealVerifyFields
            seals={seals}
            entries={entries}
            onChange={setEntries}
            colors={colors}
            onColorsChange={setColors}
            lang={lang}
          />

          <div className="space-y-2">
            <Label htmlFor="remarks">{t(lang, "remarks_optional")}</Label>
            <Textarea id="remarks" name="remarks" rows={2} placeholder="Nil" />
          </div>

          <div className="space-y-3 rounded-lg border p-4">
            <Label>Result</Label>
            <div className="grid grid-cols-2 gap-3">
              <label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 ${result === "PASS" ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30" : ""}`}>
                <input type="radio" name="result" value="PASS" checked={result === "PASS"} onChange={() => setResult("PASS")} />
                <span className="font-medium">Pass</span>
              </label>
              <label className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 ${result === "ESCALATE" ? "border-red-500 bg-red-50 dark:bg-red-950/30" : ""}`}>
                <input type="radio" name="result" value="ESCALATE" checked={result === "ESCALATE"} onChange={() => setResult("ESCALATE")} />
                <span className="font-medium">Escalate</span>
              </label>
            </div>
            {result === "ESCALATE" ? (
              <div className="space-y-2">
                <Label htmlFor="escalation_reason">Escalation reason</Label>
                <Textarea
                  id="escalation_reason"
                  name="escalation_reason"
                  value={escalationReason}
                  onChange={(event) => setEscalationReason(event.target.value)}
                  required
                />
              </div>
            ) : null}
          </div>

          <SignatureField onChange={setSignature} />
          <input type="hidden" name="signature" value={signature ?? ""} />

          {state.error ? (
            <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
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
              variant={result === "ESCALATE" ? "destructive" : "default"}
              className="w-full"
              disabled={pending || !ready}
            >
              {pending
                ? t(lang, "saving")
                : result === "ESCALATE"
                  ? "Escalate & Notify Admin"
                  : finalizes
                    ? t(lang, "approve_complete")
                    : t(lang, "approve_release")}
            </Button>
            <Link href={`/transactions/${transaction.id}/incident`} className="w-full">
              <Button type="button" variant="destructive" size="lg" className="w-full">
                {t(lang, "verification_failed")}
              </Button>
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
