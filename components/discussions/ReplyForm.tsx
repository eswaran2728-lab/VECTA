"use client";

import { useState } from "react";
import { Send, Loader2, Lock, Shield } from "lucide-react";
import { createReplyAction } from "@/lib/discussions/actions";

interface ReplyFormProps {
  threadId: string;
  isLocked: boolean;
  isRemoved: boolean;
  onReplyAdded?: () => void;
}

export function ReplyForm({ threadId, isLocked, isRemoved, onReplyAdded }: ReplyFormProps) {
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (isLocked || isRemoved) {
    return (
      <div className="p-4 rounded-xl border border-border bg-muted/30 text-center space-y-1">
        <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Lock className="h-4 w-4" />
          <span>{isLocked ? "Discussion Locked" : "Discussion Removed"}</span>
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          {isLocked
            ? "This thread is locked by a moderator. New replies cannot be added."
            : "This thread has been removed. Further discussion is closed."}
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await createReplyAction(threadId, body);
      if (res.ok) {
        setBody("");
        if (onReplyAdded) onReplyAdded();
      } else {
        setErrorMessage(res.error || "Failed to submit reply.");
      }
    } catch {
      setErrorMessage("An unexpected error occurred. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Leave an Anonymous Reply
        </h3>
        <span className="inline-flex items-center gap-1 text-[11px] text-primary">
          <Shield className="h-3 w-3" />
          <span>Alias continuity active</span>
        </span>
      </div>

      {errorMessage && (
        <div className="p-3 text-xs rounded-lg bg-destructive/15 border border-destructive/30 text-destructive-foreground">
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <textarea
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Share your perspective or answer the question. Your alias in this thread will be maintained..."
            maxLength={5000}
            disabled={isSubmitting}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
          />
          <div className="flex justify-between items-center mt-1">
            <span className="text-[11px] text-muted-foreground">
              Plain text only. Maximum 5,000 characters.
            </span>
            <span className={`text-[11px] ${body.length > 5000 ? "text-destructive" : "text-muted-foreground"}`}>
              {body.length}/5,000
            </span>
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="submit"
            disabled={isSubmitting || !body.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isSubmitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Post Anonymous Reply
          </button>
        </div>
      </form>
    </div>
  );
}
