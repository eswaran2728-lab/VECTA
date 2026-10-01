"use client";

import { useState } from "react";
import { X, AlertTriangle, ShieldCheck, Loader2 } from "lucide-react";
import { REPORT_REASONS, type ReportReason } from "@/lib/discussions/types";
import { reportContentAction } from "@/lib/discussions/actions";

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  contentType: "thread" | "reply";
  contentId: string;
  onReportSubmitted?: () => void;
}

export function ReportModal({
  isOpen,
  onClose,
  contentType,
  contentId,
  onReportSubmitted,
}: ReportModalProps) {
  const [selectedReason, setSelectedReason] = useState<ReportReason>("inappropriate_content");
  const [details, setDetails] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await reportContentAction(contentType, contentId, selectedReason, details);
      if (res.ok) {
        setIsSuccess(true);
        if (onReportSubmitted) onReportSubmitted();
        setTimeout(() => {
          setIsSuccess(false);
          onClose();
        }, 1200);
      } else {
        setErrorMessage(res.error || "Failed to submit report.");
      }
    } catch {
      setErrorMessage("Network error occurred while submitting report.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-modal-title"
    >
      <div className="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl transition-all">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/15 text-destructive border border-destructive/25">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 id="report-modal-title" className="text-base font-semibold text-foreground">
                Report {contentType === "thread" ? "Discussion" : "Reply"}
              </h2>
              <p className="text-xs text-muted-foreground">
                Confidential escalation to discussion moderators
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isSuccess ? (
          <div className="py-10 text-center space-y-3">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h3 className="text-base font-medium text-foreground">Report Submitted</h3>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Thank you for keeping VECTA discussions safe and professional. Our moderators will review this item.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {errorMessage && (
              <div className="p-3 text-xs rounded-lg bg-destructive/15 border border-destructive/30 text-destructive-foreground">
                {errorMessage}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
                Violation Reason
              </label>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {REPORT_REASONS.map((r) => (
                  <label
                    key={r.code}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedReason === r.code
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border hover:bg-muted/50 text-muted-foreground"
                    }`}
                  >
                    <input
                      type="radio"
                      name="reportReason"
                      value={r.code}
                      checked={selectedReason === r.code}
                      onChange={() => setSelectedReason(r.code)}
                      className="mt-0.5 text-primary focus:ring-primary h-4 w-4"
                    />
                    <div>
                      <span className="block text-xs font-medium text-foreground">{r.label}</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">
                        {r.description}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="report-details" className="block text-xs font-semibold text-foreground uppercase tracking-wider mb-1.5">
                Additional Context (Optional)
              </label>
              <textarea
                id="report-details"
                rows={3}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Provide any details to help moderators investigate..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                maxLength={500}
              />
            </div>

            <div className="p-3 rounded-lg bg-muted/40 border border-border text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">Anonymity Note:</span> Your identity as the reporter is strictly confidential and is never shown to the author or ordinary participants.
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-background hover:bg-muted text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-destructive hover:bg-destructive/90 text-destructive-foreground transition-colors disabled:opacity-50"
              >
                {isSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Submit Report
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
