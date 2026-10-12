"use client";

import { useState, useTransition } from "react";
import { approveReportRequest, rejectReportRequest, revokeReportGrant } from "@/lib/avsec/reports/grc";

/** Approve / reject a pending request, or revoke a grant. The database re-checks the Global Reporting Controller role on every call. */
export function GrcRowActions(props: { kind: "request"; requestId: string; requesterProfileId: string } | { kind: "grant"; grantId: string }) {
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(7);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error: string | null }>) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      setMessage(res.ok ? "Done." : (res.error ?? "Refused."));
    });

  return (
    <div className="space-y-2">
      <label className="block text-xs">
        <span className="sr-only">Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" maxLength={300} className="input-base w-full" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {props.kind === "request" ? (
          <>
            <label className="text-xs">
              <span className="sr-only">Access duration in days</span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input-base">
                {[1, 3, 7, 14, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={pending} onClick={() => run(() => approveReportRequest(props.requestId, props.requesterProfileId, reason, days))} className="btn-primary min-h-[44px] px-4 text-xs">
              Approve (read-only grant)
            </button>
            <button type="button" disabled={pending} onClick={() => run(() => rejectReportRequest(props.requestId, reason))} className="btn-secondary min-h-[44px] px-4 text-xs">
              Reject
            </button>
          </>
        ) : (
          <button type="button" disabled={pending} onClick={() => run(() => revokeReportGrant(props.grantId, reason))} className="btn-secondary min-h-[44px] px-4 text-xs">
            Revoke grant
          </button>
        )}
      </div>
      {message ? (
        <p className="font-mono text-[11px] text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
