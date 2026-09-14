"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { handoverSchema } from "@/lib/avsec/schemas/handover";
import { createHandover } from "@/lib/avsec/duty/handover-actions";

const PLACE_CATEGORIES = ["Bay", "Premises", "Terminal"] as const;

export function NewHandoverForm({
  defaultTeam,
  defaultStaffName,
  defaultStaffId,
}: {
  defaultTeam: string;
  defaultStaffName: string;
  defaultStaffId: string;
}) {
  const router = useRouter();
  const [team, setTeam] = useState(defaultTeam);
  const [staffName, setStaffName] = useState(defaultStaffName);
  const [staffId, setStaffId] = useState(defaultStaffId);
  const [placeCategory, setPlaceCategory] = useState<(typeof PLACE_CATEGORIES)[number] | "">("");
  const [placeDetail, setPlaceDetail] = useState("");
  const [flightNumber, setFlightNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = handoverSchema.safeParse({
      team,
      staff_name: staffName,
      staff_id: staffId,
      place_category: placeCategory,
      place_detail: placeDetail,
      flight_number: flightNumber,
      handover_notes: notes,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    setSubmitting(true);
    const outcome = await createHandover(parsed.data);
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    router.push("/avsec/duty/handover");
  };

  return (
    <form onSubmit={onSubmit} className="card p-4 space-y-4">
      <h2 className="section-title">Handover Details</h2>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="field-label">Team</label>
          <input className="input-base" value={team} onChange={(e) => setTeam(e.target.value)} required />
        </div>
        <div>
          <label className="field-label">Staff ID</label>
          <input className="input-base" value={staffId} onChange={(e) => setStaffId(e.target.value)} required />
        </div>
      </div>
      <div>
        <label className="field-label">Staff Name</label>
        <input className="input-base" value={staffName} onChange={(e) => setStaffName(e.target.value)} required />
      </div>

      <div>
        <label className="field-label">Place</label>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {PLACE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setPlaceCategory(cat)}
              className={
                placeCategory === cat
                  ? "py-2 px-3 rounded-lg border font-bold text-sm bg-primary/15 border-primary text-primary"
                  : "py-2 px-3 rounded-lg border font-medium text-sm bg-surface border-border text-muted-foreground hover:border-border/80"
              }
            >
              {cat}
            </button>
          ))}
        </div>
        <input
          className="input-base"
          placeholder="e.g. Bay 12, Terminal 2, or the specific premises name"
          value={placeDetail}
          onChange={(e) => setPlaceDetail(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="field-label">Flight Number (optional)</label>
        <input
          className="input-base"
          placeholder="e.g. AK703 — if you were actively attending a flight at handover time"
          value={flightNumber}
          onChange={(e) => setFlightNumber(e.target.value)}
        />
        <p className="field-hint text-[11px] text-muted-foreground font-mono mt-1">
          If the incoming staff member takes over this flight and files SEC016 for it, this
          handover will automatically appear as a remark in their report.
        </p>
      </div>

      <div>
        <label className="field-label">Handover Notes</label>
        <textarea
          className="input-base"
          rows={4}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Summarize what the incoming team needs to know…"
          required
        />
      </div>

      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}

      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? "Filing…" : "File Handover ▸"}
      </button>
    </form>
  );
}
