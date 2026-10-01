"use client";

import { useState } from "react";
import { X, ShieldAlert, UserCheck, AlertOctagon, Loader2, KeyRound } from "lucide-react";
import type { DiscussionResolvedIdentity } from "@/lib/discussions/types";
import { resolveAuthorIdentityAction } from "@/lib/discussions/actions";

interface IdentityResolutionModalProps {
  isOpen: boolean;
  onClose: () => void;
  contentType: "thread" | "reply";
  contentId: string;
  authorAlias: string;
}

export function IdentityResolutionModal({
  isOpen,
  onClose,
  contentType,
  contentId,
  authorAlias,
}: IdentityResolutionModalProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolvedData, setResolvedData] = useState<DiscussionResolvedIdentity | null>(null);

  if (!isOpen) return null;

  const handleResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 10) {
      setErrorMessage("A detailed investigation justification of at least 10 characters is required.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await resolveAuthorIdentityAction(contentType, contentId, reason);
      if (res.ok && res.data) {
        setResolvedData(res.data);
      } else {
        setErrorMessage(res.error || "Identity resolution failed or unauthorized.");
      }
    } catch {
      setErrorMessage("Network error during identity resolution.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-modal-title"
    >
      <div className="relative w-full max-w-lg rounded-xl border border-destructive/40 bg-card p-6 shadow-2xl transition-all">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/15 text-destructive border border-destructive/30">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h2 id="identity-modal-title" className="text-base font-semibold text-foreground">
                Author Identity Resolution
              </h2>
              <p className="text-xs text-muted-foreground">
                Privileged Security & Compliance Investigation
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

        {/* Warning Banner */}
        <div className="mt-4 p-3.5 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive-foreground space-y-1.5">
          <div className="flex items-center gap-2 font-semibold">
            <AlertOctagon className="h-4 w-4 text-destructive flex-shrink-0" />
            <span>MANDATORY GOVERNANCE AUDIT TRAIL</span>
          </div>
          <p className="text-[11.5px] leading-relaxed opacity-90">
            Deanonymization is strictly monitored. An immutable record containing your user profile,
            the investigated content ID, the revealed user, and your justification will be written to
            the audit log.
          </p>
        </div>

        {resolvedData ? (
          <div className="mt-5 space-y-4">
            <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <UserCheck className="h-4 w-4" />
                <span>Identity Successfully Resolved</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <span className="block text-[10.5px] uppercase tracking-wider text-muted-foreground">Author Alias</span>
                  <span className="font-mono font-medium text-foreground">{authorAlias}</span>
                </div>
                <div>
                  <span className="block text-[10.5px] uppercase tracking-wider text-muted-foreground">Staff Number</span>
                  <span className="font-mono font-bold text-foreground">{resolvedData.staff_no || "N/A"}</span>
                </div>
                <div>
                  <span className="block text-[10.5px] uppercase tracking-wider text-muted-foreground">Full Name</span>
                  <span className="font-medium text-foreground">{resolvedData.name}</span>
                </div>
                <div>
                  <span className="block text-[10.5px] uppercase tracking-wider text-muted-foreground">Official Email</span>
                  <span className="font-mono text-foreground text-[11px] truncate block">{resolvedData.email}</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Close & Finish Review
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleResolve} className="mt-4 space-y-4">
            {errorMessage && (
              <div className="p-3 text-xs rounded-lg bg-destructive/15 border border-destructive/30 text-destructive-foreground">
                {errorMessage}
              </div>
            )}

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label htmlFor="investigation-reason" className="block text-xs font-semibold text-foreground uppercase tracking-wider">
                  Official Investigation Justification
                </label>
                <span className={`text-[11px] ${reason.trim().length >= 10 ? "text-emerald-400" : "text-amber-400"}`}>
                  {reason.trim().length}/10 chars min
                </span>
              </div>
              <textarea
                id="investigation-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="State the formal case number, security incident, or policy breach requiring deanonymization..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
              />
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
                disabled={isSubmitting || reason.trim().length < 10}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-destructive hover:bg-destructive/90 text-destructive-foreground transition-colors disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                Authorize Resolution
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
