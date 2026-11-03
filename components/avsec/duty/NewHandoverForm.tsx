"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { handoverSchema } from "@/lib/avsec/schemas/handover";
import { createHandover, lookupHandoverRecipient } from "@/lib/avsec/duty/handover-actions";

const PLACE_CATEGORIES = ["Bay", "Premises", "Terminal"] as const;

export function NewHandoverForm({ senderName, senderStaffId, senderTeam }: { senderName: string; senderStaffId: string; senderTeam: string }) {
  const router = useRouter();
  const [recipientId, setRecipientId] = useState("");
  const [recipientName, setRecipientName] = useState<string | null>(null);
  const [placeCategory, setPlaceCategory] = useState<(typeof PLACE_CATEGORIES)[number] | "">("");
  const [placeDetail, setPlaceDetail] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [looking, setLooking] = useState(false);

  const lookup = async () => {
    setError(null);
    setRecipientName(null);
    if (!recipientId.trim()) return setError("Enter the receiving officer's staff ID");
    setLooking(true);
    const r = await lookupHandoverRecipient(recipientId.trim().toUpperCase());
    setLooking(false);
    if (!r.ok) return setError(r.error);
    setRecipientName(r.name);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = handoverSchema.safeParse({ recipient_staff_id: recipientId, place_category: placeCategory, place_detail: placeDetail, flight_number: flightNumber, handover_notes: notes });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Invalid input");
    if (!recipientName) return setError("Check the receiving officer's staff ID first, and confirm the name shown.");
    setSubmitting(true);
    const outcome = await createHandover(parsed.data);
    setSubmitting(false);
    if (!outcome.ok) return setError(outcome.error);
    router.push("/avsec/duty/handover");
  };

  return (
    <form onSubmit={onSubmit} className="card p-4 space-y-4">
      <h2 className="section-title">Handover Details</h2>
      <p className="font-mono text-xs text-muted-foreground">
        From: {senderName} ({senderStaffId}){senderTeam ? ` · ${senderTeam}` : ""} — taken from your sign-in. Handover is optional and never required to check out.
      </p>

      <div>
        <label className="field-label" htmlFor="ho-recipient">Receiving officer staff ID</label>
        <div className="flex gap-2">
          <input id="ho-recipient" className="input-base" value={recipientId} onChange={(e) => { setRecipientId(e.target.value); setRecipientName(null); }} autoCapitalize="characters" required />
          <button type="button" className="btn-secondary text-xs px-3" onClick={lookup} disabled={looking}>{looking ? "Checking…" : "Check"}</button>
        </div>
        {recipientName && <p className="font-mono text-xs text-success mt-1">Receiving officer: {recipientName}</p>}
        <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">Any team at your station, on duty. Only this officer can receive it.</p>
      </div>

      <div>
        <label className="field-label">Place</label>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {PLACE_CATEGORIES.map((cat) => (
            <button key={cat} type="button" onClick={() => setPlaceCategory(cat)}
              className={placeCategory === cat ? "py-2 px-3 rounded-lg border font-bold text-sm bg-primary/15 border-primary text-primary" : "py-2 px-3 rounded-lg border font-medium text-sm bg-surface border-border text-muted-foreground hover:border-border/80"}>
              {cat}
            </button>
          ))}
        </div>
        <input className="input-base" placeholder="e.g. Bay 12, Terminal 2, or the specific premises name" value={placeDetail} onChange={(e) => setPlaceDetail(e.target.value)} required />
      </div>

      <div>
        <label className="field-label">Flight Number (optional)</label>
        <input className="input-base" placeholder="e.g. AK703 — if you were actively attending a flight at handover time" value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} />
        <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">
          Once the receiving officer has completed this handover in person and files SEC016 for this flight, it appears as a remark in their report.
        </p>
      </div>

      <div>
        <label className="field-label">Handover Notes</label>
        <textarea className="input-base" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Summarize what the incoming officer needs to know…" required />
      </div>

      {error && <p className="text-xs text-destructive font-mono">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={submitting}>{submitting ? "Filing…" : "File Handover ▸"}</button>
    </form>
  );
}
