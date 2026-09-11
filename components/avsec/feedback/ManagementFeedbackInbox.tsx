"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { sendFeedbackMessage, updateFeedbackStatus } from "@/lib/avsec/feedback/actions";
import { cn } from "@/lib/avsec/utils";
import type { FeedbackCategory, FeedbackMessageRow, FeedbackStatus, ManagementFeedbackThreadView } from "@/lib/avsec/types";
import { MessageSquare, ShieldAlert, AlertCircle, Lightbulb, HelpCircle, Send, Loader2, Lock, Unlock, AlertTriangle } from "lucide-react";

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

export function ManagementFeedbackInbox({
  initialThreads,
}: {
  initialThreads: ManagementFeedbackThreadView[];
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [filterCategory, setFilterCategory] = useState<string>("ALL");
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [selectedThread, setSelectedThread] = useState<ManagementFeedbackThreadView | null>(null);
  const [messages, setMessages] = useState<FeedbackMessageRow[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  const [replyText, setReplyText] = useState("");
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [isTogglingStatus, setIsTogglingStatus] = useState(false);

  const urgentCount = threads.filter(
    (t) => t.category === "safety_concern" && t.status === "open"
  ).length;

  const filteredThreads = threads.filter((t) => {
    if (filterCategory !== "ALL" && t.category !== filterCategory) return false;
    if (filterStatus !== "ALL" && t.status !== filterStatus) return false;
    return true;
  });

  const handleOpenThread = async (thread: ManagementFeedbackThreadView) => {
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
        sender_role: "management",
        body: replyText,
        created_at: new Date().toISOString(),
      };
      setMessages([...messages, newMsg]);
      setReplyText("");
    } else {
      alert(res.error || "Failed to send reply");
    }
    setIsSendingReply(false);
  };

  const handleToggleStatus = async () => {
    if (!selectedThread) return;
    const newStatus: FeedbackStatus = selectedThread.status === "open" ? "closed" : "open";

    setIsTogglingStatus(true);
    const res = await updateFeedbackStatus({
      threadId: selectedThread.id,
      status: newStatus,
    });
    if (res.ok) {
      setSelectedThread({ ...selectedThread, status: newStatus });
      setThreads((prev) =>
        prev.map((t) => (t.id === selectedThread.id ? { ...t, status: newStatus } : t))
      );
    } else {
      alert(res.error || "Failed to update status");
    }
    setIsTogglingStatus(false);
  };

  return (
    <div className="space-y-4">
      {/* Urgent Alert Banner */}
      {urgentCount > 0 && (
        <div className="p-4 rounded-xl border border-red-500/50 bg-red-500/10 text-red-400 flex items-start gap-3 animate-pulse">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-red-500" />
          <div className="space-y-0.5 min-w-0">
            <h3 className="font-bold text-sm tracking-wide flex items-center gap-2">
              🚨 URGENT: {urgentCount} Unresolved Safety Concern{urgentCount === 1 ? "" : "s"}
            </h3>
            <p className="text-xs text-red-300 leading-relaxed">
              Staff have submitted urgent safety reports that require immediate management review and remediation.
            </p>
          </div>
        </div>
      )}

      {/* Filter Controls */}
      <div className="card p-3.5 flex flex-wrap items-center justify-between gap-3 border-border/80">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">Category:</span>
          {["ALL", "safety_concern", "complaint", "suggestion", "other"].map((c) => (
            <button
              key={c}
              onClick={() => setFilterCategory(c)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-mono font-semibold uppercase transition-all",
                filterCategory === c
                  ? "bg-primary text-primary-foreground font-bold shadow-sm"
                  : "bg-surface hover:bg-muted text-muted-foreground border border-border/60"
              )}
            >
              {c === "ALL" ? "All" : c.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-mono uppercase text-muted-foreground">Status:</span>
          {["ALL", "open", "closed"].map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-mono font-semibold uppercase transition-all",
                filterStatus === s
                  ? "bg-primary text-primary-foreground font-bold shadow-sm"
                  : "bg-surface hover:bg-muted text-muted-foreground border border-border/60"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Threads List */}
      <div className="space-y-2.5">
        {filteredThreads.length === 0 ? (
          <div className="card p-8 text-center space-y-2 border-dashed">
            <MessageSquare className="h-8 w-8 mx-auto text-muted-foreground opacity-40" />
            <p className="text-sm font-semibold">No feedback threads matching filters</p>
          </div>
        ) : (
          filteredThreads.map((t) => {
            const meta = CATEGORY_META[t.category];
            const Icon = meta.icon;
            const isSelected = selectedThread?.id === t.id;
            const isSafety = t.category === "safety_concern" && t.status === "open";

            return (
              <div
                key={t.id}
                onClick={() => handleOpenThread(t)}
                className={cn(
                  "card p-4 transition-all cursor-pointer border hover:border-primary/60",
                  isSelected
                    ? "border-primary bg-primary/5 shadow-sm"
                    : isSafety
                    ? "border-red-500/60 bg-red-500/5 dark:bg-red-950/20"
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

                      <span className="text-[10px] font-mono text-muted-foreground">
                        Thread #{t.id.slice(0, 8)}
                      </span>

                      <span className="text-[11px] text-muted-foreground font-mono">
                        · {formatDateTimeMY(t.updated_at || t.created_at)}
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

      {/* Selected Thread Drawer / Reply Box */}
      {selectedThread && (
        <div className="card p-5 border-border/80 bg-surface/95 space-y-4 mt-6">
          <div className="flex flex-wrap items-center justify-between border-b border-border/60 pb-3 gap-2">
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
                Thread #{selectedThread.id.slice(0, 8)} · Submitter: [Anonymous Staff]
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isTogglingStatus}
                onClick={handleToggleStatus}
                className={cn(
                  "btn-secondary text-xs px-2.5 py-1 flex items-center gap-1",
                  selectedThread.status === "open" ? "hover:text-red-400" : "hover:text-emerald-400"
                )}
              >
                {isTogglingStatus ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : selectedThread.status === "open" ? (
                  <>
                    <Lock className="h-3.5 w-3.5" />
                    <span>Close Thread</span>
                  </>
                ) : (
                  <>
                    <Unlock className="h-3.5 w-3.5" />
                    <span>Reopen Thread</span>
                  </>
                )}
              </button>

              <button
                onClick={() => setSelectedThread(null)}
                className="text-xs font-mono text-muted-foreground hover:text-foreground"
              >
                Close ✕
              </button>
            </div>
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
                        ? "ml-auto bg-primary/10 border border-primary/20 text-foreground"
                        : "mr-auto bg-surface border border-border text-foreground"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-bold font-mono text-[10px] uppercase text-primary">
                        {isManagement ? "🏢 Management (You)" : "👤 Anonymous Staff"}
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

          {/* Management Reply Form */}
          {selectedThread.status === "open" ? (
            <form onSubmit={handleSendReply} className="flex gap-2 pt-2 border-t border-border/60">
              <input
                type="text"
                required
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type official Management reply..."
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
                <span>Reply</span>
              </button>
            </form>
          ) : (
            <div className="p-2.5 rounded bg-muted/50 text-center text-xs text-muted-foreground">
              This thread is closed. Reopen to send additional replies.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
