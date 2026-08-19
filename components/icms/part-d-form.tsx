"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { completePartD, type ActionState } from "@/lib/icms/actions/transactions";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";
import { BigCheckbox } from "@/components/icms/ui/checkbox";
import { Label } from "@/components/icms/ui/label";
import { Input } from "@/components/icms/ui/input";
import { Select } from "@/components/icms/ui/select";
import { Textarea } from "@/components/icms/ui/textarea";
import { SignatureField } from "@/components/icms/signature-pad";
import { SealVerifyFields } from "@/components/icms/seal-verify-fields";
import { formDataToPayload, queueSubmission } from "@/lib/icms/offline-queue";
import { DELIVERY_LOCATION_LABELS } from "@/lib/icms/constants";
import { t, type Lang } from "@/lib/icms/i18n";
import type { Seal, Transaction } from "@/lib/icms/database.types";

const initialState: ActionState = { error: null };

export function PartDForm({
  transaction,
  seals,
  receiverName,
  receiverStaffId,
  lang = "en",
}: {
  transaction: Transaction;
  seals: Pick<Seal, "id" | "seal_number" | "seal_type" | "seal_color">[];
  receiverName: string;
  receiverStaffId: string;
  lang?: Lang;
}) {
  const [state, formAction, pending] = useActionState(completePartD, initialState);
  const [sealIntact, setSealIntact] = useState(false);
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [queuedMsg, setQueuedMsg] = useState<string | null>(null);
  const [result, setResult] = useState<"PASS" | "ESCALATE">("PASS");
  const [escalationReason, setEscalationReason] = useState("");
  const [deliveryLocation, setDeliveryLocation] = useState("");
  const [aircraftIdentifier, setAircraftIdentifier] = useState("");

  const malaysiaNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" })
  );
  const defaultDate = `${malaysiaNow.getFullYear()}-${String(malaysiaNow.getMonth() + 1).padStart(2, "0")}-${String(malaysiaNow.getDate()).padStart(2, "0")}`;
  const defaultTime = `${String(malaysiaNow.getHours()).padStart(2, "0")}:${String(malaysiaNow.getMinutes()).padStart(2, "0")}`;

  const allSealsEntered = seals.every(
    (s) => (entries[s.id] ?? "").trim() !== "" && (colors[s.id] ?? "").trim() !== ""
  );

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
            <p className="text-xs text-muted-foreground">{t(lang, "vehicle")}</p>
            <p className="font-mono text-lg font-bold">{transaction.vehicle_number}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t(lang, "driver")}</p>
            <p className="text-lg font-bold">{transaction.driver_name}</p>
          </div>
        </div>

        <form action={formAction} onSubmit={handleOffline} className="space-y-4">
          <input type="hidden" name="transaction_id" value={transaction.id} />
          <input type="hidden" name="seal_entries" value={JSON.stringify(entries)} />
          <input type="hidden" name="seal_colors" value={JSON.stringify(colors)} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="receiver_name">Receiver Name</Label>
              <Input id="receiver_name" name="receiver_name" defaultValue={receiverName} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="receiver_staff_id">Receiver ID / Badge number</Label>
              <Input id="receiver_staff_id" name="receiver_staff_id" defaultValue={receiverStaffId} required />
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

          <div className="space-y-2">
            <Label htmlFor="delivery_location">{t(lang, "delivery_location")}</Label>
            <Select
              id="delivery_location"
              name="delivery_location"
              required
              value={deliveryLocation}
              onChange={(e) => setDeliveryLocation(e.target.value)}
            >
              <option value="" disabled>
                {t(lang, "select_location")}
              </option>
              {Object.entries(DELIVERY_LOCATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          {deliveryLocation === "AIRCRAFT" ? (
            <div className="space-y-2">
              <Label htmlFor="aircraft_identifier">Aircraft Identifier</Label>
              <Input
                id="aircraft_identifier"
                name="aircraft_identifier"
                placeholder="e.g. 9M-AQD"
                autoCapitalize="characters"
                value={aircraftIdentifier}
                onChange={(e) => setAircraftIdentifier(e.target.value)}
                className="font-mono"
                required
              />
              <p className="text-xs text-muted-foreground">
                Self-reported — no staff at the aircraft to verify it.
              </p>
            </div>
          ) : null}

          <SealVerifyFields
            seals={seals}
            entries={entries}
            onChange={setEntries}
            colors={colors}
            onColorsChange={setColors}
            lang={lang}
          />

          <BigCheckbox
            id="seal_intact"
            name="seal_intact"
            label={t(lang, "seals_intact")}
            description={t(lang, "seals_intact_desc")}
            checked={sealIntact}
            onCheckedChange={setSealIntact}
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
                <Textarea id="escalation_reason" name="escalation_reason" value={escalationReason} onChange={(event) => setEscalationReason(event.target.value)} required />
              </div>
            ) : null}
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
              disabled={
                pending ||
                !allSealsEntered ||
                !signature ||
                (deliveryLocation === "AIRCRAFT" && !aircraftIdentifier.trim()) ||
                (result === "PASS" ? !sealIntact : escalationReason.trim().length === 0)
              }
            >
              {pending ? t(lang, "saving") : t(lang, "confirm_delivery")}
            </Button>
            <Link href={`/icms/transactions/${transaction.id}/incident`} className="w-full">
              <Button type="button" variant="destructive" size="lg" className="w-full">
                {t(lang, "seal_problem")}
              </Button>
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
