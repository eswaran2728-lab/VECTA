"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestReportAccess } from "@/lib/avsec/reports/access-requests";

export function RequestAccessButton({ reportId, label }: { reportId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState(7);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Request access to ${label}`} className="btn-secondary min-h-[44px] px-4 text-xs">
        {open ? "Cancel" : "Request access"}
      </button>
      {open && (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="font-mono text-muted-foreground">Business reason (at least 10 characters) *</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="input-base w-full" maxLength={500} />
          </label>
          <label className="block text-xs">
            <span className="font-mono text-muted-foreground">Access needed for</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input-base ml-2">
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={pending || reason.trim().length < 10}
            className="btn-primary min-h-[44px] px-4 text-xs"
            onClick={() =>
              start(async () => {
                setMessage(null);
                const res = await requestReportAccess(reportId, reason, days);
                setMessage(res.ok ? "Request sent to the Global Reporting Controller." : (res.error ?? "Refused."));
                if (res.ok) {
                  setOpen(false);
                  router.refresh();
                }
              })
            }
          >
            {pending ? "Sending…" : "Send request"}
          </button>
        </div>
      )}
      {message && (
        <p className="font-mono text-[11px] text-muted-foreground" role="status">{message}</p>
      )}
    </div>
  );
}
