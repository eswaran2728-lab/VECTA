"use client";

import { useActionState, useState } from "react";
import { resolveIncident, type ResolveState } from "@/lib/actions/incidents";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { INCIDENT_STATUS_LABELS, lifecycleFor } from "@/lib/constants";
import type { IncidentStatus, IncidentType } from "@/lib/database.types";

const initialState: ResolveState = { error: null, success: null };

/** Admin lifecycle controls: forward-only, notes mandatory to resolve/close.
 *  SEGMENT_TIMEOUT incidents get the lighter OPEN -> RESOLVED lifecycle;
 *  every other type keeps the full OPEN -> UNDER_REVIEW -> RESOLVED -> CLOSED. */
export function IncidentResolve({
  incidentId,
  incidentType,
  currentStatus,
}: {
  incidentId: string;
  incidentType: IncidentType;
  currentStatus: IncidentStatus;
}) {
  const [state, action, pending] = useActionState(resolveIncident, initialState);
  const [target, setTarget] = useState<IncidentStatus | "">("");

  const order = lifecycleFor(incidentType);
  const options = order.slice(order.indexOf(currentStatus) + 1);
  if (options.length === 0) return null;

  const needsNotes = target === "RESOLVED" || target === "CLOSED";

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="incident_id" value={incidentId} />
      <div className="flex items-center gap-2">
        <Select
          name="status"
          value={target}
          onChange={(e) => setTarget(e.target.value as IncidentStatus)}
          className="h-9 w-auto text-sm"
          required
        >
          <option value="" disabled>
            Move to…
          </option>
          {options.map((s) => (
            <option key={s} value={s}>
              {INCIDENT_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" variant="outline" disabled={pending || !target}>
          {pending ? "Saving…" : "Update"}
        </Button>
      </div>
      {needsNotes ? (
        <Textarea
          name="resolution_notes"
          rows={2}
          required
          placeholder="Resolution notes (mandatory)…"
          className="text-sm"
        />
      ) : (
        <input type="hidden" name="resolution_notes" value="" />
      )}
      {state.error ? <p className="text-xs text-red-600">{state.error}</p> : null}
      {state.success ? <p className="text-xs text-emerald-600">{state.success}</p> : null}
    </form>
  );
}
