"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { WoisConfidenceBadge } from "./WoisConfidenceBadge";
import type { WoisConversation, WoisMessage, WoisSuggestedAction } from "@/lib/avsec/types";
import {
  Sparkles,
  X,
  Send,
  Loader2,
  Plus,
  History,
  FileText,
  ChevronRight,
  Download,
  Pencil,
  Trash2,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

interface WoisChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  userContext?: {
    role?: string | null;
    ops_group?: string | null;
    station?: string | null;
    team?: string | null;
  };
}

export function WoisChatModal({ isOpen, onClose, userContext }: WoisChatModalProps) {
  const [conversations, setConversations] = useState<WoisConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WoisMessage[]>([]);
  const [inputQuery, setInputQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showHistorySidebar, setShowHistorySidebar] = useState(false);
  const [eligibility, setEligibility] = useState<{ checked: boolean; eligible: boolean }>({
    checked: false,
    eligible: false,
  });
  const [suggestedActions, setSuggestedActions] = useState<WoisSuggestedAction[]>([]);
  const [lastFailedQuery, setLastFailedQuery] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Close on Escape -- keyboard-friendly interaction.
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  // Eligibility is re-checked every time the modal opens -- never assumed
  // from a prior open, since the caller's assignment can change between
  // sessions.
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        const res = await fetch("/api/wois/eligibility");
        const data = await res.json();
        setEligibility({ checked: true, eligible: Boolean(data.eligible) });
        setSuggestedActions(Array.isArray(data.suggestedActions) ? data.suggestedActions : []);
      } catch {
        setEligibility({ checked: true, eligible: false });
      }
    })();
  }, [isOpen]);

  // Load conversation list when modal opens
  useEffect(() => {
    if (isOpen) {
      loadConversations();
    }
  }, [isOpen]);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId);
    } else {
      setMessages([]);
    }
  }, [activeConversationId]);

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function loadConversations() {
    try {
      const res = await fetch("/api/wois/history");
      const data = await res.json();
      if (data.conversations) {
        setConversations(data.conversations);
        if (data.conversations.length > 0 && !activeConversationId) {
          setActiveConversationId(data.conversations[0].id);
        }
      }
    } catch (err) {
      console.error("Failed to load WOIS conversations:", err);
    }
  }

  async function loadMessages(convId: string) {
    try {
      const res = await fetch(`/api/wois/history?conversationId=${convId}`);
      const data = await res.json();
      if (data.messages) {
        setMessages(data.messages);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  async function handleSendMessage(queryToSend?: string) {
    const text = queryToSend || inputQuery;
    if (!text.trim() || isLoading) return;

    setInputQuery("");
    setIsLoading(true);
    setLastFailedQuery(null);

    // Optimistic user message
    const tempUserMsg: WoisMessage = {
      id: "temp-" + Date.now(),
      conversation_id: activeConversationId || "new",
      sender: "user",
      body: text,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await fetch("/api/wois/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationId: activeConversationId,
          userContext,
        }),
      });

      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.conversationId && data.conversationId !== activeConversationId) {
        setActiveConversationId(data.conversationId);
        loadConversations();
      }

      const assistantMsg: WoisMessage = {
        id: "ast-" + Date.now(),
        conversation_id: data.conversationId || activeConversationId || "new",
        sender: "assistant",
        body: data.response.body,
        confidence_tag: data.response.confidence_tag,
        source_type: data.response.source_type,
        sources: data.response.sources,
        attachment: data.response.attachment,
        actionHref: data.response.actionHref,
        actionLabel: data.response.actionLabel,
        created_at: new Date().toISOString(),
      };

      setMessages((prev) => [...prev.filter((m) => m.id !== tempUserMsg.id), tempUserMsg, assistantMsg]);
    } catch (err: unknown) {
      const errorText = err instanceof Error ? err.message : "An unexpected error occurred";
      const errorMsg: WoisMessage = {
        id: "err-" + Date.now(),
        conversation_id: activeConversationId || "new",
        sender: "assistant",
        body: `Error: Unable to process response (${errorText}). Please try again.`,
        confidence_tag: "UNCERTAIN",
        source_type: "general",
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
      setLastFailedQuery(text);
    } finally {
      setIsLoading(false);
    }
  }

  function handleStartNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setShowHistorySidebar(false);
    setLastFailedQuery(null);
  }

  async function handleRenameConversation(id: string) {
    const title = renameValue.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    try {
      await fetch(`/api/wois/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    } finally {
      setRenamingId(null);
    }
  }

  async function handleDeleteConversation(id: string) {
    try {
      await fetch(`/api/wois/conversations/${id}`, { method: "DELETE" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationId === id) {
        setActiveConversationId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="W.O.I.S AI Assistant"
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-card border-l border-border shadow-2xl text-foreground">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/80 px-5 py-4 bg-card/95 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/30 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-bold tracking-wider text-foreground">
                  W.O.I.S AI
                </h2>
                <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary border border-primary/30">
                  V2.0
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Work Order Intelligence Smartbook · Malaysia Staff Assistant
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowHistorySidebar(!showHistorySidebar)}
              aria-label="Conversation history"
              className="flex items-center gap-1 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
              title="Conversation History"
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">History</span>
            </button>

            <button
              onClick={handleStartNewChat}
              aria-label="Start a new chat"
              className="flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20"
              title="New Chat"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New</span>
            </button>

            <button
              onClick={onClose}
              aria-label="Close W.O.I.S AI"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground transition cursor-pointer"
              title="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* History Drawer Overlay */}
        {showHistorySidebar && (
          <div className="absolute top-[65px] left-0 bottom-0 z-20 w-72 border-r border-border bg-card p-4 shadow-xl flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-border/60">
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                Past Conversations
              </span>
              <button
                onClick={() => setShowHistorySidebar(false)}
                className="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto space-y-1.5">
              {conversations.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No past chats yet.</p>
              ) : (
                conversations.map((c) =>
                  renamingId === c.id ? (
                    <form
                      key={c.id}
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleRenameConversation(c.id);
                      }}
                      className="flex items-center gap-1 p-1.5"
                    >
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameConversation(c.id)}
                        className="flex-1 rounded-md border border-primary/40 bg-input px-2 py-1 text-xs text-foreground focus:outline-none"
                        aria-label="Conversation title"
                      />
                    </form>
                  ) : (
                    <div
                      key={c.id}
                      className={`group w-full rounded-lg text-xs transition border flex items-center justify-between ${
                        activeConversationId === c.id
                          ? "bg-primary/10 border-primary/40 text-primary font-medium"
                          : "bg-card/40 border-border/60 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                      }`}
                    >
                      <button
                        onClick={() => {
                          setActiveConversationId(c.id);
                          setShowHistorySidebar(false);
                        }}
                        className="flex-1 min-w-0 text-left p-2.5 flex items-center justify-between cursor-pointer"
                      >
                        <span className="truncate pr-2">{c.title}</span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      </button>
                      <button
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameValue(c.title);
                        }}
                        aria-label={`Rename "${c.title}"`}
                        title="Rename"
                        className="shrink-0 p-1.5 opacity-0 group-hover:opacity-100 hover:text-primary cursor-pointer"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleDeleteConversation(c.id)}
                        aria-label={`Delete "${c.title}"`}
                        title="Delete"
                        className="shrink-0 p-1.5 pr-2.5 opacity-0 group-hover:opacity-100 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )
                )
              )}
            </div>
          </div>
        )}

        {/* Chat Content Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {eligibility.checked && !eligibility.eligible ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 space-y-3">
              <div className="h-14 w-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
                <ShieldAlert className="h-7 w-7" />
              </div>
              <h3 className="font-display text-base font-bold text-foreground">W.O.I.S AI is not available for your account</h3>
              <p className="max-w-sm text-xs text-muted-foreground leading-relaxed">
                In this phase, W.O.I.S AI 2.0 is available only to approved, actively assigned Malaysia AOC staff.
                If you believe this is incorrect, contact your Duty Security Executive (DSE) or station management.
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 space-y-6">
              <div className="h-14 w-14 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                <Sparkles className="h-7 w-7" />
              </div>

              <div className="max-w-md space-y-1.5">
                <h3 className="font-display text-lg font-bold text-foreground">
                  W.O.I.S Operational Assistant
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Ask real operational questions on ground procedures, minimum search timings, dangerous goods limits, unruly passenger levels, or VECTA application guides.
                </p>
              </div>

              {/* Suggestion Chips -- role-adapted, server-computed */}
              {suggestedActions.length > 0 && (
                <div className="w-full max-w-lg space-y-2">
                  <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
                    Suggested Queries
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {suggestedActions.map((s, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSendMessage(s.query)}
                        className="text-left px-3 py-2 rounded-xl bg-card border border-border text-xs text-foreground hover:border-primary hover:bg-primary/5 transition cursor-pointer"
                      >
                        {s.label} &rarr;
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="max-w-md text-[10.5px] text-muted-foreground/80 leading-relaxed border-t border-border/50 pt-3">
                AI may make mistakes — verify operational decisions against the official SOP or your DSE.
                Only your own conversations are visible to you; nobody else, including administrators, can read them.
              </p>
            </div>
          ) : (
            messages.map((m) => {
              const isUser = m.sender === "user";
              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${isUser ? "items-end" : "items-start"} space-y-1.5`}
                >
                  <div
                    className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      isUser
                        ? "bg-primary text-primary-foreground font-medium shadow-sm"
                        : "bg-card border border-border text-foreground shadow-sm"
                    }`}
                  >
                    {!isUser && m.confidence_tag && (
                      <div className="mb-2.5 pb-2 border-b border-border/60 flex items-center justify-between gap-2">
                        <WoisConfidenceBadge tag={m.confidence_tag} />
                        {m.source_type && (
                          <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                            Tier: {m.source_type}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed">
                      {m.body}
                    </div>

                    {!isUser && m.attachment && (
                      <div className="mt-3 pt-2.5 border-t border-border/60">
                        <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-primary/5 border border-primary/30 shadow-sm">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 border border-primary/30 text-primary shrink-0">
                              <FileText className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-display text-[13px] font-bold text-foreground truncate">
                                {m.attachment.title || m.attachment.filename}
                              </p>
                              <p className="font-mono text-[10.5px] text-muted-foreground">
                                Original PDF · 41 Pages
                              </p>
                            </div>
                          </div>
                          <a
                            href={m.attachment.url}
                            download={m.attachment.filename}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold transition hover:opacity-90 shrink-0"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>Download PDF</span>
                          </a>
                        </div>
                      </div>
                    )}

                    {!isUser && m.sources && m.sources.length > 0 && (
                      <div className="mt-3 pt-2.5 border-t border-border/60 text-[11px] text-muted-foreground space-y-1.5">
                        <p className="font-mono text-[10px] uppercase tracking-wider text-primary">
                          Sources &amp; Citations:
                        </p>
                        <div className="flex flex-col gap-1.5">
                          {m.sources.map((src, i) => (
                            <div
                              key={i}
                              className="rounded bg-secondary px-2 py-1.5 border border-border text-[10.5px] text-foreground"
                            >
                              <span className="inline-flex items-center gap-1">
                                <FileText className="h-3 w-3 text-primary shrink-0" />
                                {src.documentTitle}
                                {src.pageNumber ? ` · p.${src.pageNumber}` : ""}
                                {src.sectionTitle ? ` (${src.sectionTitle})` : ""}
                              </span>
                              {(src.version || src.lastReviewed) && (
                                <span className="block mt-0.5 font-mono text-[9.5px] text-muted-foreground">
                                  {src.version ? `v${src.version}` : ""}
                                  {src.version && src.lastReviewed ? " · " : ""}
                                  {src.lastReviewed ? `last reviewed ${src.lastReviewed}` : ""}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!isUser && m.actionHref && m.actionLabel && (
                      <div className="mt-3 pt-2.5 border-t border-border/60">
                        <Link
                          href={m.actionHref}
                          onClick={onClose}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold transition hover:opacity-90"
                        >
                          {m.actionLabel} →
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {isLoading && (
            <div className="flex items-center gap-2.5 text-xs text-primary font-mono py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Analyzing SOPs and knowledge base...</span>
            </div>
          )}

          {!isLoading && lastFailedQuery && (
            <div className="flex justify-start">
              <button
                onClick={() => handleSendMessage(lastFailedQuery)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="border-t border-border/80 p-3.5 bg-card/95 backdrop-blur-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              placeholder="Ask an SOP, DG limit, or app help question..."
              aria-label="Message W.O.I.S AI"
              className="flex-1 rounded-xl border border-border bg-input px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none disabled:opacity-50"
              disabled={isLoading || (eligibility.checked && !eligibility.eligible)}
              maxLength={2000}
            />

            <button
              type="submit"
              aria-label="Send message"
              disabled={!inputQuery.trim() || isLoading || (eligibility.checked && !eligibility.eligible)}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 cursor-pointer"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
