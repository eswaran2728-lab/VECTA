"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { DiscussionResolvedIdentity, ModerationAction, ReportReason, ReportStatus } from "./types";

export interface ActionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Server Action: Create a new anonymous discussion thread.
 */
export async function createThreadAction(
  categoryId: string,
  title: string,
  body: string
): Promise<ActionResult<{ id: string; author_alias: string }>> {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();

  if (!trimmedTitle) {
    return { ok: false, error: "Title is required." };
  }
  if (trimmedTitle.length > 200) {
    return { ok: false, error: "Title cannot exceed 200 characters." };
  }
  if (!trimmedBody) {
    return { ok: false, error: "Body content is required." };
  }
  if (trimmedBody.length > 10000) {
    return { ok: false, error: "Body cannot exceed 10,000 characters." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_discussion_thread_secure", {
    p_category_id: categoryId,
    p_title: trimmedTitle,
    p_body: trimmedBody,
  });

  if (error || !data || data.length === 0) {
    return { ok: false, error: error?.message || "Failed to create discussion thread." };
  }

  revalidatePath("/avsec/discussions");
  return { ok: true, data: data[0] as { id: string; author_alias: string } };
}

/**
 * Server Action: Submit a reply to an open discussion thread.
 */
export async function createReplyAction(
  threadId: string,
  body: string
): Promise<ActionResult<{ id: string; author_alias: string }>> {
  const trimmedBody = body.trim();

  if (!trimmedBody) {
    return { ok: false, error: "Reply body cannot be empty." };
  }
  if (trimmedBody.length > 5000) {
    return { ok: false, error: "Reply cannot exceed 5,000 characters." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_discussion_reply_secure", {
    p_thread_id: threadId,
    p_body: trimmedBody,
  });

  if (error || !data || data.length === 0) {
    return { ok: false, error: error?.message || "Failed to submit reply." };
  }

  revalidatePath(`/avsec/discussions/${threadId}`);
  revalidatePath("/avsec/discussions");
  return { ok: true, data: data[0] as { id: string; author_alias: string } };
}

/**
 * Server Action: Author edits their own thread or reply.
 */
export async function editContentAction(
  contentType: "thread" | "reply",
  contentId: string,
  body: string,
  threadId: string
): Promise<ActionResult> {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { ok: false, error: "Content body cannot be blank." };
  }
  const maxLen = contentType === "thread" ? 10000 : 5000;
  if (trimmedBody.length > maxLen) {
    return { ok: false, error: `Content exceeds maximum allowed length of ${maxLen} characters.` };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("edit_discussion_content_secure", {
    p_content_type: contentType,
    p_content_id: contentId,
    p_body: trimmedBody,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Failed to update content." };
  }

  revalidatePath(`/avsec/discussions/${threadId}`);
  revalidatePath("/avsec/discussions");
  return { ok: true };
}

/**
 * Server Action: Author removes (soft-deletes) their own thread or reply.
 */
export async function removeOwnContentAction(
  contentType: "thread" | "reply",
  contentId: string,
  threadId: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_own_discussion_content_secure", {
    p_content_type: contentType,
    p_content_id: contentId,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Failed to remove content." };
  }

  revalidatePath(`/avsec/discussions/${threadId}`);
  revalidatePath("/avsec/discussions");
  return { ok: true };
}

/**
 * Server Action: Report abusive or policy-violating content.
 */
export async function reportContentAction(
  contentType: "thread" | "reply",
  contentId: string,
  reason: ReportReason,
  details?: string
): Promise<ActionResult<{ reportId: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_discussion_content_secure", {
    p_content_type: contentType,
    p_content_id: contentId,
    p_reason: reason,
    p_details: details?.trim() || null,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Failed to file report." };
  }

  return { ok: true, data: { reportId: data as string } };
}

/**
 * Server Action: Moderator actions (hide, restore, lock, unlock).
 */
export async function moderateContentAction(
  contentType: "thread" | "reply",
  contentId: string,
  action: ModerationAction,
  reason: string,
  threadId: string
): Promise<ActionResult> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return { ok: false, error: "A specific moderation reason is required for audit logs." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("moderate_discussion_content_secure", {
    p_content_type: contentType,
    p_content_id: contentId,
    p_action: action,
    p_reason: trimmedReason,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Moderation action failed." };
  }

  revalidatePath(`/avsec/discussions/${threadId}`);
  revalidatePath("/avsec/discussions");
  revalidatePath("/avsec/discussions/moderation");
  return { ok: true };
}

/**
 * Server Action: Moderator reviews or dismisses a report.
 */
export async function reviewReportAction(
  reportId: string,
  status: ReportStatus,
  reason: string
): Promise<ActionResult> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    return { ok: false, error: "A reason is required to close/review a report." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_discussion_report_secure", {
    p_report_id: reportId,
    p_status: status,
    p_reason: trimmedReason,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Failed to update report status." };
  }

  revalidatePath("/avsec/discussions/moderation");
  return { ok: true };
}

/**
 * Server Action: Privileged, strictly audited, single-item identity resolution.
 * Requires minimum 10-character justification.
 */
export async function resolveAuthorIdentityAction(
  contentType: "thread" | "reply",
  contentId: string,
  reason: string
): Promise<ActionResult<DiscussionResolvedIdentity>> {
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 10) {
    return {
      ok: false,
      error: "Formal investigation justification requires at least 10 characters.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("resolve_discussion_author_identity_secure", {
    p_content_type: contentType,
    p_content_id: contentId,
    p_reason: trimmedReason,
  });

  if (error || !data || data.length === 0) {
    return { ok: false, error: error?.message || "Identity resolution failed or denied." };
  }

  revalidatePath("/avsec/discussions/moderation");
  return { ok: true, data: data[0] as DiscussionResolvedIdentity };
}
