"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { submitOtRequest } from "@/lib/avsec/duty/ot-actions";
import { Clock, ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import { OPS_GROUP_LABELS, type OpsGroup } from "@/lib/avsec/reference-data";
import type { Profile } from "@/lib/avsec/types";

export function OtNewForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);

  const [workDate, setWorkDate] = useState(today);
  const [hours, setHours] = useState("2");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append("workDate", workDate);
    formData.append("hours", hours);
    formData.append("reason", reason);

    const res = await submitOtRequest(formData);
    if (res.error) {
      setError(res.error);
      setLoading(false);
    } else {
      router.push("/avsec/duty/ot");
    }
  };

  return (
    <div className="space-y-4">
      <Link
        href="/avsec/duty/ot"
        className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>Back to OT Management</span>
      </Link>

      <form onSubmit={handleSubmit} className="vecta-panel space-y-5 px-6 py-6">
        <div>
          <h1 className="font-display text-lg font-bold tracking-[0.02em] text-foreground flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Submit Overtime (OT) Request
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Your request will be routed directly to the{" "}
            <strong>
              {profile.ops_group ? OPS_GROUP_LABELS[profile.ops_group as OpsGroup] : "Branch"}{" "}
              DSE
            </strong>{" "}
            for approval.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="work-date" className="vecta-label">
              Date of Overtime *
            </label>
            <input
              id="work-date"
              type="date"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              required
              className="vecta-input"
            />
          </div>

          <div>
            <label htmlFor="hours" className="vecta-label">
              Overtime Hours *
            </label>
            <input
              id="hours"
              type="number"
              step="0.5"
              min="0.5"
              max="24"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              required
              placeholder="e.g. 2.0"
              className="vecta-input"
            />
          </div>
        </div>

        <div>
          <label htmlFor="reason" className="vecta-label">
            Operational Justification / Reason *
          </label>
          <textarea
            id="reason"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            placeholder="Describe the operational reason for overtime (e.g. flight delay, additional ramp patrols, VIP movement coverage)…"
            className="vecta-input resize-none"
          />
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-xs text-brand font-medium">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Link
            href="/avsec/duty/ot"
            className="rounded-lg border border-border px-4 py-2 font-mono text-xs text-muted-foreground hover:bg-secondary cursor-pointer"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={loading || !reason.trim()}
            className="vecta-btn-primary flex items-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>Submit Request</span>
          </button>
        </div>
      </form>
    </div>
  );
}
