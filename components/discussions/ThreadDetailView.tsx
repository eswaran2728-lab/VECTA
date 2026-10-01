"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Shield,
  Clock,
  Lock,
  Unlock,
  AlertTriangle,
  Edit2,
  Trash2,
  EyeOff,
  Eye,
  KeyRound,
  Loader2,
  MessageSquare,
} from "lucide-react";
import type { DiscussionThreadDetail, DiscussionReply } from "@/lib/discussions/types";
import { formatTimeMY } from "@/lib/avsec/datetime";
import {
  editContentAction,
  removeOwnContentAction,
  moderateContentAction,
} from "@/lib/discussions/actions";
import { ReplyForm } from "./ReplyForm";
import { ReportModal } from "./ReportModal";
import { IdentityResolutionModal } from "./IdentityResolutionModal";

interface ThreadDetailViewProps {
  thread: DiscussionThreadDetail;
  categoryName: string;
  isThreadOwner: boolean;
  ownedReplyIds: string[];
  isModerator: boolean;
}

export function ThreadDetailView({
  thread: initialThread,
  categoryName,
  isThreadOwner,
  ownedReplyIds,
  isModerator,
}: ThreadDetailViewProps) {
  const router = useRouter();
  const [thread, setThread] = useState(initialThread);

  // Thread editing state
  const [isEditingThread, setIsEditingThread] = useState(false);
  const [editThreadBody, setEditThreadBody] = useState(thread.body);
  const [isSavingThreadEdit, setIsSavingThreadEdit] = useState(false);
  const [threadEditError, setThreadEditError] = useState<string | null>(null);

  // Reply editing state (keyed by replyId)
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editReplyBody, setEditReplyBody] = useState("");
  const [isSavingReplyEdit, setIsSavingReplyEdit] = useState(false);

  // Report modal state
  const [reportTarget, setReportTarget] = useState<{
    contentType: "thread" | "reply";
    contentId: string;
  } | null>(null);

  // Identity resolution modal state
  const [identityTarget, setIdentityTarget] = useState<{
    contentType: "thread" | "reply";
    contentId: string;
    authorAlias: string;
  } | null>(null);

  // Action loading states
  const [busyContentId, setBusyContentId] = useState<string | null>(null);

  // Save thread edit
  const handleSaveThreadEdit = async () => {
    if (!editThreadBody.trim()) return;
    setIsSavingThreadEdit(true);
    setThreadEditError(null);
    try {
      const res = await editContentAction("thread", thread.id, editThreadBody, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          body: editThreadBody,
          edited_at: new Date().toISOString(),
        }));
        setIsEditingThread(false);
      } else {
        setThreadEditError(res.error || "Failed to update thread.");
      }
    } catch {
      setThreadEditError("An unexpected error occurred.");
    } finally {
      setIsSavingThreadEdit(false);
    }
  };

  // Remove thread
  const handleRemoveThread = async () => {
    if (!window.confirm("Are you sure you want to remove your discussion post? This cannot be undone.")) {
      return;
    }
    setBusyContentId(thread.id);
    try {
      const res = await removeOwnContentAction("thread", thread.id, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          status: "removed",
          body: "[This post has been removed.]",
          author_alias: "[removed]",
        }));
      }
    } finally {
      setBusyContentId(null);
    }
  };

  // Moderator lock / unlock thread
  const handleToggleLock = async () => {
    const action = thread.status === "locked" ? "unlock" : "lock";
    const reason = window.prompt(`Reason for ${action}ing this thread:`, "Routine policy moderation");
    if (!reason || !reason.trim()) return;

    setBusyContentId(thread.id);
    try {
      const res = await moderateContentAction("thread", thread.id, action, reason, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          status: action === "lock" ? "locked" : "open",
        }));
      }
    } finally {
      setBusyContentId(null);
    }
  };

  // Moderator hide / restore thread
  const handleToggleHideThread = async () => {
    const action = thread.status === "removed" ? "restore" : "hide";
    const reason = window.prompt(`Reason for ${action}ing this thread:`, "Policy compliance review");
    if (!reason || !reason.trim()) return;

    setBusyContentId(thread.id);
    try {
      const res = await moderateContentAction("thread", thread.id, action, reason, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          status: action === "hide" ? "removed" : "open",
        }));
      }
    } finally {
      setBusyContentId(null);
    }
  };

  // Reply handlers
  const handleSaveReplyEdit = async (replyId: string) => {
    if (!editReplyBody.trim()) return;
    setIsSavingReplyEdit(true);
    try {
      const res = await editContentAction("reply", replyId, editReplyBody, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          replies: prev.replies.map((r) =>
            r.id === replyId ? { ...r, body: editReplyBody, edited_at: new Date().toISOString() } : r
          ),
        }));
        setEditingReplyId(null);
      }
    } finally {
      setIsSavingReplyEdit(false);
    }
  };

  const handleRemoveReply = async (replyId: string) => {
    if (!window.confirm("Are you sure you want to remove this reply?")) return;
    setBusyContentId(replyId);
    try {
      const res = await removeOwnContentAction("reply", replyId, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          replies: prev.replies.map((r) =>
            r.id === replyId
              ? {
                  ...r,
                  status: "removed",
                  body: "[This post has been removed.]",
                  author_alias: "[removed]",
                }
              : r
          ),
        }));
      }
    } finally {
      setBusyContentId(null);
    }
  };

  const handleModerateReply = async (reply: DiscussionReply, action: "hide" | "restore") => {
    const reason = window.prompt(`Reason for ${action}ing reply:`, "Content violation");
    if (!reason || !reason.trim()) return;

    setBusyContentId(reply.id);
    try {
      const res = await moderateContentAction("reply", reply.id, action, reason, thread.id);
      if (res.ok) {
        setThread((prev) => ({
          ...prev,
          replies: prev.replies.map((r) =>
            r.id === reply.id ? { ...r, status: action === "hide" ? "removed" : "visible" } : r
          ),
        }));
      }
    } finally {
      setBusyContentId(null);
    }
  };

  const isThreadLocked = thread.status === "locked";
  const isThreadRemoved = thread.status === "removed";

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 space-y-6">
      {/* Back button */}
      <div>
        <Link
          href="/avsec/discussions"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Discussions</span>
        </Link>
      </div>

      {/* Main Thread Card */}
      <article className="rounded-xl border border-border bg-card p-5 sm:p-7 shadow-sm space-y-5">
        {/* Status Banners */}
        {isThreadLocked && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400">
            <Lock className="h-4 w-4 flex-shrink-0" />
            <span>This discussion has been locked by a moderator. No further replies can be added.</span>
          </div>
        )}
        {isThreadRemoved && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>This discussion has been removed in accordance with moderation policy.</span>
          </div>
        )}

        {/* Header Details */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-border/80">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-medium bg-muted text-muted-foreground border border-border">
                {categoryName}
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-semibold bg-primary/10 text-primary border border-primary/20">
                <Shield className="h-3 w-3" />
                <span>{thread.author_alias}</span>
              </span>
            </div>

            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              {thread.title}
            </h1>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                <span>{formatTimeMY(thread.created_at)}</span>
              </span>
              {thread.edited_at && <span>(edited {formatTimeMY(thread.edited_at)})</span>}
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center gap-2 flex-wrap self-start">
            {/* Author Controls */}
            {isThreadOwner && !isThreadRemoved && !isEditingThread && (
              <>
                <button
                  type="button"
                  onClick={() => setIsEditingThread(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border bg-background hover:bg-muted text-foreground transition-colors"
                  title="Edit discussion"
                >
                  <Edit2 className="h-3.5 w-3.5" />
                  <span>Edit</span>
                </button>
                <button
                  type="button"
                  onClick={handleRemoveThread}
                  disabled={busyContentId === thread.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                  title="Delete discussion"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Remove</span>
                </button>
              </>
            )}

            {/* Ordinary user Report */}
            {!isThreadOwner && !isThreadRemoved && (
              <button
                type="button"
                onClick={() => setReportTarget({ contentType: "thread", contentId: thread.id })}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Report content"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span>Report</span>
              </button>
            )}

            {/* Moderator Controls */}
            {isModerator && (
              <div className="flex items-center gap-1.5 pl-2 border-l border-border">
                <button
                  type="button"
                  onClick={handleToggleLock}
                  disabled={busyContentId === thread.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
                  title={isThreadLocked ? "Unlock thread" : "Lock thread"}
                >
                  {isThreadLocked ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                  <span>{isThreadLocked ? "Unlock" : "Lock"}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleHideThread}
                  disabled={busyContentId === thread.id}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                  title={isThreadRemoved ? "Restore thread" : "Hide thread"}
                >
                  {isThreadRemoved ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  <span>{isThreadRemoved ? "Restore" : "Hide"}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setIdentityTarget({
                      contentType: "thread",
                      contentId: thread.id,
                      authorAlias: thread.author_alias,
                    })
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                  title="Audited Identity Resolution"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  <span>Deanonymize</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Thread Content */}
        {isEditingThread ? (
          <div className="space-y-3">
            {threadEditError && (
              <div className="p-2.5 text-xs rounded-lg bg-destructive/15 border border-destructive/30 text-destructive-foreground">
                {threadEditError}
              </div>
            )}
            <textarea
              rows={6}
              value={editThreadBody}
              onChange={(e) => setEditThreadBody(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed"
              maxLength={10000}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditThreadBody(thread.body);
                  setIsEditingThread(false);
                }}
                disabled={isSavingThreadEdit}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-muted text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveThreadEdit}
                disabled={isSavingThreadEdit || !editThreadBody.trim()}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isSavingThreadEdit && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none text-foreground text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words">
            {thread.body}
          </div>
        )}
      </article>

      {/* Replies Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-tight text-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span>Replies ({thread.replies.length})</span>
          </h2>
        </div>

        {thread.replies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-1">
            <p className="text-xs font-medium text-foreground">No replies yet</p>
            <p className="text-[11.5px] text-muted-foreground">
              Be the first to join the conversation.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {thread.replies.map((reply) => {
              const isReplyOwner = ownedReplyIds.includes(reply.id);
              const isReplyRemoved = reply.status === "removed";
              const isEditingThisReply = editingReplyId === reply.id;

              return (
                <div
                  key={reply.id}
                  className={`rounded-xl border p-4 sm:p-5 transition-colors ${
                    isReplyRemoved
                      ? "border-border/60 bg-muted/20 opacity-80"
                      : "border-border bg-card shadow-sm"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2.5 pb-2 border-b border-border/50">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-semibold bg-primary/10 text-primary border border-primary/20">
                        <Shield className="h-2.5 w-2.5" />
                        <span>{reply.author_alias}</span>
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {formatTimeMY(reply.created_at)}
                      </span>
                      {reply.edited_at && (
                        <span className="text-[10.5px] text-muted-foreground">(edited)</span>
                      )}
                      {isReplyRemoved && (
                        <span className="text-[10.5px] font-medium text-destructive bg-destructive/10 px-1.5 py-0.2 rounded border border-destructive/20">
                          Removed
                        </span>
                      )}
                    </div>

                    {/* Reply Action Buttons */}
                    <div className="flex items-center gap-1.5">
                      {isReplyOwner && !isReplyRemoved && !isEditingThisReply && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingReplyId(reply.id);
                              setEditReplyBody(reply.body);
                            }}
                            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                            title="Edit reply"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveReply(reply.id)}
                            disabled={busyContentId === reply.id}
                            className="p-1 rounded text-destructive hover:bg-destructive/15 transition-colors"
                            title="Delete reply"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </>
                      )}

                      {!isReplyOwner && !isReplyRemoved && (
                        <button
                          type="button"
                          onClick={() => setReportTarget({ contentType: "reply", contentId: reply.id })}
                          className="p-1 rounded text-muted-foreground hover:text-amber-400 hover:bg-muted transition-colors"
                          title="Report reply"
                        >
                          <AlertTriangle className="h-3 w-3" />
                        </button>
                      )}

                      {isModerator && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleModerateReply(reply, isReplyRemoved ? "restore" : "hide")}
                            disabled={busyContentId === reply.id}
                            className="p-1 rounded text-destructive hover:bg-destructive/15 transition-colors"
                            title={isReplyRemoved ? "Restore reply" : "Hide reply"}
                          >
                            {isReplyRemoved ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setIdentityTarget({
                                contentType: "reply",
                                contentId: reply.id,
                                authorAlias: reply.author_alias,
                              })
                            }
                            className="p-1 rounded text-destructive hover:bg-destructive/15 transition-colors"
                            title="Deanonymize reply author"
                          >
                            <KeyRound className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isEditingThisReply ? (
                    <div className="space-y-2 mt-2">
                      <textarea
                        rows={3}
                        value={editReplyBody}
                        onChange={(e) => setEditReplyBody(e.target.value)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        maxLength={5000}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingReplyId(null)}
                          disabled={isSavingReplyEdit}
                          className="px-2.5 py-1 text-xs rounded border border-border hover:bg-muted text-foreground"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveReplyEdit(reply.id)}
                          disabled={isSavingReplyEdit || !editReplyBody.trim()}
                          className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
                      {reply.body}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Reply Submission Form */}
        <ReplyForm
          threadId={thread.id}
          isLocked={isThreadLocked}
          isRemoved={isThreadRemoved}
          onReplyAdded={() => router.refresh()}
        />
      </section>

      {/* Report Modal */}
      {reportTarget && (
        <ReportModal
          isOpen={Boolean(reportTarget)}
          contentType={reportTarget.contentType}
          contentId={reportTarget.contentId}
          onClose={() => setReportTarget(null)}
        />
      )}

      {/* Identity Resolution Modal */}
      {identityTarget && (
        <IdentityResolutionModal
          isOpen={Boolean(identityTarget)}
          contentType={identityTarget.contentType}
          contentId={identityTarget.contentId}
          authorAlias={identityTarget.authorAlias}
          onClose={() => setIdentityTarget(null)}
        />
      )}
    </div>
  );
}
