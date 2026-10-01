"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { MessageSquare, Plus, Search, Lock, Shield, Clock, AlertCircle } from "lucide-react";
import type { DiscussionCategory, DiscussionThreadSummary } from "@/lib/discussions/types";
import { formatTimeMY } from "@/lib/avsec/datetime";

interface DiscussionListProps {
  categories: DiscussionCategory[];
  threads: DiscussionThreadSummary[];
  isModerator: boolean;
}

export function DiscussionList({ categories, threads, isModerator }: DiscussionListProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredThreads = useMemo(() => {
    return threads.filter((t) => {
      if (selectedCategory !== "all" && t.category_id !== selectedCategory) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = t.title.toLowerCase().includes(q);
        const matchesAlias = t.author_alias.toLowerCase().includes(q);
        return matchesTitle || matchesAlias;
      }
      return true;
    });
  }, [threads, selectedCategory, searchQuery]);

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) {
      map.set(c.id, c.display_name);
    }
    return map;
  }, [categories]);

  return (
    <div className="space-y-6">
      {/* Top Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
            Anonymous Discussion Board
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Internal, identity-protected collaboration and operational knowledge exchange.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {isModerator && (
            <Link
              href="/avsec/discussions/moderation"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>Moderation Dashboard</span>
            </Link>
          )}
          <Link
            href="/avsec/discussions/new"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" />
            <span>New Discussion</span>
          </Link>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        {/* Category Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-thin">
          <button
            type="button"
            onClick={() => setSelectedCategory("all")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              selectedCategory === "all"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            All Categories ({threads.length})
          </button>
          {categories.map((c) => {
            const count = threads.filter((t) => t.category_id === c.id).length;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedCategory(c.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  selectedCategory === c.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {c.display_name} ({count})
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search discussions or alias..."
            className="w-full rounded-lg border border-border bg-background pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Thread List */}
      {filteredThreads.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center space-y-3">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquare className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">No discussions found</h3>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            {searchQuery
              ? "No discussions match your current search terms. Try clearing the search."
              : "No discussions have been posted in this category yet. Be the first to start the conversation!"}
          </p>
          <div className="pt-2">
            <Link
              href="/avsec/discussions/new"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create First Discussion</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border/60 rounded-xl border border-border bg-card overflow-hidden shadow-sm">
          {filteredThreads.map((thread) => {
            const catName = categoryMap.get(thread.category_id) || "General";
            const isLocked = thread.status === "locked";
            const isRemoved = thread.status === "removed";

            return (
              <Link
                key={thread.id}
                href={`/avsec/discussions/${thread.id}`}
                className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-muted/40 transition-colors"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-medium bg-muted text-muted-foreground border border-border">
                      {catName}
                    </span>
                    {isLocked && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
                        <Lock className="h-3 w-3" />
                        <span>Locked</span>
                      </span>
                    )}
                    {isRemoved && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-destructive/15 text-destructive border border-destructive/30">
                        <AlertCircle className="h-3 w-3" />
                        <span>Removed</span>
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10.5px] font-medium bg-primary/10 text-primary border border-primary/20">
                      <Shield className="h-2.5 w-2.5" />
                      <span>{thread.author_alias}</span>
                    </span>
                  </div>

                  <h2 className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                    {thread.title}
                  </h2>

                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>{formatTimeMY(thread.created_at)}</span>
                    </span>
                    {thread.edited_at && <span>(edited)</span>}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs flex-shrink-0 self-end sm:self-center">
                  {isModerator && thread.report_count > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-destructive/15 text-destructive border border-destructive/30">
                      {thread.report_count} {thread.report_count === 1 ? "report" : "reports"}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted/60 text-muted-foreground font-mono text-xs">
                    <MessageSquare className="h-3.5 w-3.5 text-primary" />
                    <span className="font-semibold text-foreground">{thread.reply_count}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
