"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { submitFeedbackThread, sendFeedbackMessage } from "@/lib/avsec/feedback/actions";
import { cn } from "@/lib/avsec/utils";
import type { FeedbackCategory, FeedbackMessageRow, FeedbackThreadRow } from "@/lib/avsec/types";
import { MessageSquare, ShieldAlert, AlertCircle, Lightbulb, HelpCircle, Send, Plus, X, Loader2 } from "lucide-react";

interface ThreadWithDetails extends FeedbackThreadRow {
  last_message?: string;
  message_count: number;
}

const CATEGORY_META: Record<FeedbackCategory, { label: string; icon: typeof ShieldAlert; color: string; bg: string; border: string }> = {
  safety_concern: {
    label: "Safety Concern",
    icon: ShieldAlert,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
  },
  complaint: {
    label: "Complaint",
    icon: AlertCircle,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
  },
  suggestion: {
    label: "Suggestion",
    icon: Lightbulb,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
  },
  other: {
    label: "Other",
    icon: HelpCircle,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
  },
};

export function StaffFeedbackList({
  initialThreads,
}: {
  initialThreads: ThreadWithDetails[];
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedThread, setSelectedThread] = useState<ThreadWithDetails | null>(null);
  const [messages, setMessages] = useState<FeedbackMessageRow[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // Form states
  const [category, setCategory] = useState<FeedbackCategory>("safety_concern");
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSendingReply, setIsSendingReply] = useState(false);

  const handleOpenThread = async (thread: ThreadWithDetails) => {
    setSelectedThread(thread);
    setIsLoadingMessages(true);
    try {
      const res = await fetch(`/api/avsec/feedback/${thread.id}/messages`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch {
      // Fallback
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const handleCreateThread = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;

    setIsSubmitting(true);
    const res = await submitFeedbackThread({ category, body });
    if (res.ok && res.threadId) {
      const newThread: ThreadWithDetails = {
        id: res.threadId,
        org_id: null,
        submitter_id: "",
        category,
        status: "open",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_message: body,
        message_count: 1,
      };
      setThreads([newThread, ...threads]);
      setBody("");
      setIsCreating(false);
      handleOpenThread(newThread);
    } else {
      alert(res.error || "Failed to submit feedback");
    }
    setIsSubmitting(false);
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedThread || !replyText.trim()) return;

    setIsSendingReply(true);
    const res = await sendFeedbackMessage({
      threadId: selectedThread.id,
      body: replyText,
    });
    if (res.ok && res.messageId) {
      const newMsg: FeedbackMessageRow = {
        id: res.messageId,
        thread_id: selectedThread.id,
        sender_role: "submitter",
        body: replyText,
        created_at: new Date().toISOString(),
      };
      setMessages([...messages, newMsg]);
      setReplyText("");
    } else {
      alert(res.error || "Failed to send message");
    }
    setIsSendingReply(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">My Anonymous Feedback</h2>
          <p className="text-xs text-muted-foreground">
            Management can read and reply to your feedback without ever seeing your identity.
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="btn-primary flex items-center gap-1.5 text-xs"
        >
          <Plus className="h-4 w-4" />
          <span>New Feedback</span>
        </button>
      </div>

      {/* Creation Modal / Form */}
      {isCreating && (
        <div className="card p-5 border-border/80 bg-surface/90 space-y-4 transition-all">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              Submit Anonymous Feedback
            </h3>
            <button
              onClick={() => setIsCreating(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleCreateThread} className="space-y-3">
            <div>
              <label className="field-label">Feedback Category</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(["safety_concern", "complaint", "suggestion", "other"] as FeedbackCategory[]).map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const Icon = meta.icon;
                  const isSel = category === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      className={cn(
                        "flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all cursor-pointer",
                        isSel
                          ? cn(meta.bg, meta.border, meta.color, "ring-1 ring-primary/40 font-bold")
                          : "border-border/60 hover:bg-surface text-muted-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 mb-1" />
                      <span className="text-xs">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="field-label">Your Message</label>
              <textarea
                required
                rows={4}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Describe your feedback, suggestion, or safety observation in detail. Your name and role are completely hidden from Management."
                className="input-base w-full text-sm leading-relaxed"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !body.trim()}
                className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span>Submit Anonymously</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Threads List */}
      <div className="space-y-2.5">
        {threads.length === 0 ? (
          <div className="card p-8 text-center space-y-2 border-dashed">
            <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground opacity-40" />
            <p className="text-sm font-semibold">No feedback submitted yet</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              You can anonymously report safety hazards, workplace concerns, or constructive suggestions directly to management.
            </p>
          </div>
        ) : (
          threads.map((t) => {
            const meta = CATEGORY_META[t.category];
            const Icon = meta.icon;
            const isSelected = selectedThread?.id === t.id;

            return (
              <div
                key={t.id}
                onClick={() => handleOpenThread(t)}
                className={cn(
                  "card p-4 transition-all cursor-pointer border hover:border-primary/50",
                  isSelected
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-border/80 bg-surface/80"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-mono font-bold uppercase",
                          meta.bg,
                          meta.color,
                          meta.border
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </span>

                      <span
                        className={cn(
                          "px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase",
                          t.status === "open"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-muted text-muted-foreground"
                        )}
                      >
                        {t.status}
                      </span>

                      <span className="text-[11px] text-muted-foreground font-mono">
                        {formatDateTimeMY(t.updated_at || t.created_at)}
                      </span>
                    </div>

                    <p className="text-xs text-foreground/90 line-clamp-2 leading-relaxed">
                      {t.last_message || "No message content"}
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs font-mono font-bold px-2 py-1 rounded bg-surface border border-border text-muted-foreground">
                      {t.message_count} msg{t.message_count === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Selected Thread Chat Drawer / View */}
      {selectedThread && (
        <div className="card p-5 border-border/80 bg-surface/95 space-y-4 mt-6">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "px-2 py-0.5 rounded text-xs font-mono font-bold uppercase",
                  CATEGORY_META[selectedThread.category].bg,
                  CATEGORY_META[selectedThread.category].color
                )}
              >
                {CATEGORY_META[selectedThread.category].label}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                Thread · {selectedThread.status.toUpperCase()}
              </span>
            </div>
            <button
              onClick={() => setSelectedThread(null)}
              className="text-xs font-mono text-muted-foreground hover:text-foreground"
            >
              Close Thread View ✕
            </button>
          </div>

          {/* Conversation history */}
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {isLoadingMessages ? (
              <div className="text-center py-6">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                <p className="text-xs text-muted-foreground mt-2">Loading conversation...</p>
              </div>
            ) : messages.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No messages in thread.</p>
            ) : (
              messages.map((m) => {
                const isManagement = m.sender_role === "management";
                return (
                  <div
                    key={m.id}
                    className={cn(
                      "flex flex-col max-w-[85%] rounded-lg p-3 text-xs leading-relaxed",
                      isManagement
                        ? "mr-auto bg-primary/10 border border-primary/20 text-foreground"
                        : "ml-auto bg-surface border border-border text-foreground"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-bold font-mono text-[10px] uppercase text-primary">
                        {isManagement ? "🏢 Management Response" : "👤 You (Anonymous)"}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {formatDateTimeMY(m.created_at)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                );
              })
            )}
          </div>

          {/* Reply Form */}
          {selectedThread.status === "open" ? (
            <form onSubmit={handleSendReply} className="flex gap-2 pt-2 border-t border-border/60">
              <input
                type="text"
                required
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type a reply to Management..."
                className="input-base flex-1 text-xs"
              />
              <button
                type="submit"
                disabled={isSendingReply || !replyText.trim()}
                className="btn-primary text-xs px-3 shrink-0 flex items-center gap-1 disabled:opacity-50"
              >
                {isSendingReply ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                <span>Send</span>
              </button>
            </form>
          ) : (
            <div className="p-2.5 rounded bg-muted/50 text-center text-xs text-muted-foreground">
              This thread has been closed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
