"use client";

import { useState } from "react";
import { approveEntityRegistration, rejectEntityRegistration, type EntityRegistrationRequestRow } from "@/lib/avsec/admin/entity-registrations";

/**
 * Minimum-viable entity-admin registration review UI (Phase 13
 * correction). This is deliberately a plain form, not a polished
 * dashboard -- visual/UX work for this surface is explicitly deferred to
 * the next phase's dashboard adjustment (docs/phase13/dashboard-adjustment-inventory.md).
 * All authorization is server-side RPC-enforced; this component has no
 * security logic of its own.
 */
export function EntityRegistrationsView({ requests }: { requests: EntityRegistrationRequestRow[] }) {
  const [rows, setRows] = useState(requests);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function handleApprove(formData: FormData) {
    setError(null);
    const res = await approveEntityRegistration(formData);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== formData.get("requestId")));
  }

  async function handleReject(formData: FormData) {
    setError(null);
    const res = await rejectEntityRegistration(formData);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== formData.get("requestId")));
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No pending registration requests for your entity.</p>;
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-500">{error}</p>}
      {rows.map((r) => (
        <div key={r.id} className="card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">Requested role: {r.requested_role_code ?? "(unspecified)"}</p>
              <p className="text-xs text-muted-foreground">
                Entity: {r.operating_entity_code} · Submitted {new Date(r.submitted_at).toLocaleString()}
              </p>
            </div>
            <button type="button" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)} className="btn-secondary text-xs">
              {expandedId === r.id ? "Close" : "Review"}
            </button>
          </div>

          {expandedId === r.id && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-2 border-t border-border">
              <form action={handleApprove} className="space-y-2">
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="operatingEntityCode" value={r.operating_entity_code} />
                <label className="text-xs font-mono text-muted-foreground">Approve as role code</label>
                <input name="roleCode" defaultValue={r.requested_role_code ?? ""} className="input-base w-full text-xs" required />
                <label className="text-xs font-mono text-muted-foreground">AOC id</label>
                <input name="aocId" className="input-base w-full text-xs" required placeholder="AOC uuid" />
                <button type="submit" className="btn-primary w-full text-xs">
                  Approve
                </button>
              </form>
              <form action={handleReject} className="space-y-2">
                <input type="hidden" name="requestId" value={r.id} />
                <label className="text-xs font-mono text-muted-foreground">Rejection reason</label>
                <input name="reason" className="input-base w-full text-xs" required placeholder="Reason" />
                <button type="submit" className="btn-secondary w-full text-xs">
                  Reject
                </button>
              </form>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
