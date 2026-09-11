"use client";

import { useState, useEffect, useRef } from "react";
import { WoisConfidenceBadge } from "./WoisConfidenceBadge";
import type { WoisConversation, WoisMessage } from "@/lib/avsec/types";
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

const SUGGESTION_PROMPTS = [
  { label: "A330 Search Timing", query: "What is the minimum aircraft search timing for an A330?" },
  { label: "Power Bank Wh Limit", query: "Can a 20,000mAh power bank board in carry-on baggage?" },
  { label: "Give me W.O.I.S", query: "Give me W.O.I.S" },
  { label: "How to Submit OT", query: "How do I submit an Overtime (OT) request in VECTA?" },
  { label: "Unruly Passenger Levels", query: "What are the levels of disruptive passengers and actions?" },
];

export function WoisChatModal({ isOpen, onClose, userContext }: WoisChatModalProps) {
  const [conversations, setConversations] = useState<WoisConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WoisMessage[]>([]);
  const [inputQuery, setInputQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showHistorySidebar, setShowHistorySidebar] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    } finally {
      setIsLoading(false);
    }
  }

  function handleStartNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setShowHistorySidebar(false);
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-[#0f141c] border-l border-cyan-500/20 shadow-2xl text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/80 px-5 py-4 bg-[#141b26]/90 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/30 border border-cyan-500/40 text-cyan-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-bold tracking-wider text-cyan-300">
                  W.O.I.S AI
                </h2>
                <span className="rounded bg-cyan-950/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-400 border border-cyan-800/60">
                  V1.0
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                World of Intelligent Aviation Systems · Staff Assistant
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowHistorySidebar(!showHistorySidebar)}
              className="flex items-center gap-1 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-cyan-500/40 hover:text-cyan-300"
              title="Conversation History"
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">History</span>
            </button>

            <button
              onClick={handleStartNewChat}
              className="flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20"
              title="New Chat"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">New</span>
            </button>

            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground transition"
              title="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* History Drawer Overlay */}
        {showHistorySidebar && (
          <div className="absolute top-[65px] left-0 bottom-0 z-20 w-72 border-r border-border bg-[#111722] p-4 shadow-xl flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-border/60">
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                Past Conversations
              </span>
              <button
                onClick={() => setShowHistorySidebar(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 flex-1 overflow-y-auto space-y-1.5">
              {conversations.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No past chats yet.</p>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setActiveConversationId(c.id);
                      setShowHistorySidebar(false);
                    }}
                    className={`w-full text-left p-2.5 rounded-lg text-xs transition border flex items-center justify-between ${
                      activeConversationId === c.id
                        ? "bg-cyan-950/40 border-cyan-500/40 text-cyan-200"
                        : "bg-card/40 border-border/60 text-muted-foreground hover:border-cyan-500/30 hover:text-foreground"
                    }`}
                  >
                    <span className="truncate pr-2">{c.title}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* Chat Content Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 space-y-6">
              <div className="h-14 w-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                <Sparkles className="h-7 w-7" />
              </div>

              <div className="max-w-md space-y-1.5">
                <h3 className="font-display text-lg font-bold text-slate-100">
                  W.O.I.S Operational Assistant
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Ask real operational questions on ground procedures, minimum search timings, dangerous goods limits, unruly passenger levels, or VECTA application guides.
                </p>
              </div>

              {/* Suggestion Chips */}
              <div className="w-full max-w-lg space-y-2">
                <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
                  Suggested Queries
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {SUGGESTION_PROMPTS.map((s, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSendMessage(s.query)}
                      className="text-left px-3 py-2 rounded-xl bg-card/60 border border-border/80 text-xs text-slate-300 hover:border-cyan-500/50 hover:bg-cyan-950/20 hover:text-cyan-200 transition"
                    >
                      {s.label} &rarr;
                    </button>
                  ))}
                </div>
              </div>
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
                        ? "bg-cyan-600/20 border border-cyan-500/40 text-cyan-100"
                        : "bg-[#141c28] border border-border text-slate-200"
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
                        <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-cyan-950/40 border border-cyan-500/40 shadow-sm">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 shrink-0">
                              <FileText className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-display text-[13px] font-bold text-slate-100 truncate">
                                {m.attachment.title || m.attachment.filename}
                              </p>
                              <p className="font-mono text-[10.5px] text-cyan-400/80">
                                Original PDF · 41 Pages
                              </p>
                            </div>
                          </div>
                          <a
                            href={m.attachment.url}
                            download={m.attachment.filename}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500 text-black text-xs font-bold transition hover:bg-cyan-400 shrink-0"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>Download PDF</span>
                          </a>
                        </div>
                      </div>
                    )}

                    {!isUser && m.sources && m.sources.length > 0 && (
                      <div className="mt-3 pt-2.5 border-t border-border/60 text-[11px] text-muted-foreground space-y-1">
                        <p className="font-mono text-[10px] uppercase tracking-wider text-cyan-400/80">
                          Sources &amp; Citations:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {m.sources.map((src, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 rounded bg-card/60 px-2 py-0.5 border border-border text-[10.5px]"
                            >
                              <FileText className="h-3 w-3 text-cyan-400" />
                              {src.documentTitle}
                              {src.pageNumber ? ` · p.${src.pageNumber}` : ""}
                              {src.sectionTitle ? ` (${src.sectionTitle})` : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {isLoading && (
            <div className="flex items-center gap-2.5 text-xs text-cyan-400 font-mono py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Analyzing SOPs and knowledge base...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="border-t border-border/80 p-3.5 bg-[#141b26]/90 backdrop-blur-md">
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
              className="flex-1 rounded-xl border border-border bg-[#0b0f15] px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-cyan-500 focus:outline-none"
              disabled={isLoading}
            />

            <button
              type="submit"
              disabled={!inputQuery.trim() || isLoading}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500 text-black transition hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
