"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SignatureField } from "@/components/icms/signature-pad";
import { confirmFinalReceipt, type PendingReceipt } from "@/lib/avsec/caterlink/receipt";

/** Final-receipt confirmation for one movement. Verification checkboxes + a mandatory discrepancy note when any is unchecked + signature. */
export function ReceiptForm({ row, station }: { row: PendingReceipt; station: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [route, setRoute] = useState(false);
  const [seal, setSeal] = useState(false);
  const [delivery, setDelivery] = useState(false);
  const [discrepancy, setDiscrepancy] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const allOk = route && seal && delivery;
  const ready = Boolean(signature) && (allOk || discrepancy.trim().length >= 5);

  return (
    <article className="card space-y-2 p-4" aria-label={`Movement ${row.transactionNumber}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{row.transactionNumber}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {row.direction} · {row.route ?? "—"} · {row.status ?? "—"} · {row.originStation ?? "?"} → {row.destinationStation ?? station}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            Vehicle {row.vehicleNumber} · driver {row.driverName} · seal {row.sealNumber ?? "—"} · flight {row.flightNumber ?? "—"} {row.aircraftRegistration ?? ""} · trolleys{" "}
            {row.trolleyCount ?? "—"}
          </p>
        </div>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="btn-secondary min-h-[44px] px-4 text-xs">
          {open ? "Close" : "Confirm receipt"}
        </button>
      </div>
      {open && (
        <form
          className="space-y-3 border-t border-border pt-3"
          action={(fd) => {
            fd.set("transactionId", row.id);
            fd.set("station", station);
            fd.set("signature", signature ?? "");
            start(async () => {
              setMessage(null);
              const res = await confirmFinalReceipt(fd);
              if (!res.ok) return setMessage(res.error ?? "Refused.");
              setMessage(res.pdfVersion ? `Receipt recorded. Final PDF version ${res.pdfVersion} is ready.` : "Receipt recorded. The final PDF is pending and will be generated automatically; CaterLink Management can see its status.");
              router.refresh();
            });
          }}
        >
          <fieldset className="space-y-2">
            <legend className="font-mono text-xs font-bold">Verify what was delivered</legend>
            <label className="flex min-h-[44px] items-center gap-2 text-xs">
              <input type="checkbox" name="routeOk" checked={route} onChange={(e) => setRoute(e.target.checked)} /> Route and destination match this station
            </label>
            <label className="flex min-h-[44px] items-center gap-2 text-xs">
              <input type="checkbox" name="sealOk" checked={seal} onChange={(e) => setSeal(e.target.checked)} /> Seal number {row.sealNumber ?? "(none recorded)"} is intact and matches
            </label>
            <label className="flex min-h-[44px] items-center gap-2 text-xs">
              <input type="checkbox" name="deliveryOk" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} /> Delivery details (vehicle, driver, trolleys) match
            </label>
          </fieldset>
          {!allOk && (
            <label className="block space-y-1 text-xs">
              <span className="font-mono text-muted-foreground">Discrepancy (required when anything is not confirmed) *</span>
              <textarea name="discrepancy" value={discrepancy} onChange={(e) => setDiscrepancy(e.target.value)} rows={3} className="input-base w-full" maxLength={500} required />
            </label>
          )}
          <SignatureField label="Receiver signature" onChange={setSignature} />
          <button type="submit" disabled={!ready || pending} className="btn-primary min-h-[44px] w-full text-xs">
            {pending ? "Recording…" : allOk ? "Record final receipt" : "Record receipt with discrepancy"}
          </button>
        </form>
      )}
      {message && (
        <p className="font-mono text-[11px] text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </article>
  );
}
