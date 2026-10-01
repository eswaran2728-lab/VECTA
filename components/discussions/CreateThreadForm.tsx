"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Shield, Send, Loader2, Info } from "lucide-react";
import type { DiscussionCategory } from "@/lib/discussions/types";
import { createThreadAction } from "@/lib/discussions/actions";

interface CreateThreadFormProps {
  categories: DiscussionCategory[];
  defaultCategoryId?: string;
}

export function CreateThreadForm({ categories, defaultCategoryId }: CreateThreadFormProps) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState(defaultCategoryId || categories[0]?.id || "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!categoryId) {
      setErrorMessage("Please select a category.");
      return;
    }
    if (!title.trim()) {
      setErrorMessage("Please enter a discussion title.");
      return;
    }
    if (!body.trim()) {
      setErrorMessage("Please enter discussion content.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await createThreadAction(categoryId, title, body);
      if (res.ok && res.data) {
        router.push(`/avsec/discussions/${res.data.id}`);
      } else {
        setErrorMessage(res.error || "Failed to create discussion thread.");
      }
    } catch {
      setErrorMessage("An unexpected error occurred. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/avsec/discussions"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Discussions</span>
        </Link>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">
            Start a New Anonymous Discussion
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Exchange operational insights, raise questions, or share suggestions anonymously with team colleagues.
          </p>
        </div>

        {/* Anonymity Banner */}
        <div className="p-4 rounded-lg bg-primary/10 border border-primary/20 text-xs text-foreground space-y-1">
          <div className="flex items-center gap-2 font-semibold text-primary">
            <Shield className="h-4 w-4" />
            <span>End-to-End Participant Anonymity</span>
          </div>
          <p className="text-muted-foreground text-[11.5px] leading-relaxed">
            Your post will be published under a thread-scoped anonymous alias (e.g. &quot;Silent Falcon&quot;).
            Your real name, staff number, and email are never shown to participants or accessible in standard API responses.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 text-xs rounded-lg bg-destructive/15 border border-destructive/30 text-destructive-foreground">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="discussion-category" className="block text-xs font-semibold text-foreground uppercase tracking-wider mb-1.5">
              Category
            </label>
            <select
              id="discussion-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={isSubmitting}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.display_name} {cat.description ? `— ${cat.description}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label htmlFor="discussion-title" className="block text-xs font-semibold text-foreground uppercase tracking-wider">
                Title
              </label>
              <span className={`text-[11px] ${title.length > 200 ? "text-destructive" : "text-muted-foreground"}`}>
                {title.length}/200
              </span>
            </div>
            <input
              id="discussion-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Summary of the topic (e.g., Gate C3 apron transfer coordination)..."
              maxLength={200}
              disabled={isSubmitting}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5">
              <label htmlFor="discussion-body" className="block text-xs font-semibold text-foreground uppercase tracking-wider">
                Discussion Content
              </label>
              <span className={`text-[11px] ${body.length > 10000 ? "text-destructive" : "text-muted-foreground"}`}>
                {body.length}/10,000
              </span>
            </div>
            <textarea
              id="discussion-body"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Describe your observation, suggestion, or question in detail. Plain text is preserved safely..."
              maxLength={10000}
              disabled={isSubmitting}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary leading-relaxed font-sans"
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              <span>Posts must adhere to professional aviation security conduct guidelines.</span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="/avsec/discussions"
                className="px-4 py-2 text-xs font-medium rounded-lg border border-border bg-background hover:bg-muted text-foreground transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting || !title.trim() || !body.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                Publish Discussion
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
