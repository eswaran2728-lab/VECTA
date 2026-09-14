"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/avsec/auth";
import type { FeedbackCategory, FeedbackStatus } from "@/lib/avsec/types";

export interface FeedbackActionResult {
  ok: boolean;
  threadId?: string;
  messageId?: string;
  error?: string;
}

/**
 * Submit a new anonymous staff feedback thread + initial message.
 */
export async function submitFeedbackThread({
  category,
  body,
}: {
  category: FeedbackCategory;
  body: string;
}): Promise<FeedbackActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const trimmedBody = body.trim();
  if (!trimmedBody) return { ok: false, error: "Feedback message cannot be blank." };

  const validCategories: FeedbackCategory[] = ["safety_concern", "complaint", "suggestion", "other"];
  if (!validCategories.includes(category)) {
    return { ok: false, error: "Invalid feedback category." };
  }

  const supabase = await createClient();

  // Insert thread
  const { data: thread, error: threadError } = await supabase
    .from("feedback_threads")
    .insert({
      submitter_id: profile.id,
      category,
      status: "open",
    })
    .select("id, category")
    .single();

  if (threadError || !thread) {
    return { ok: false, error: threadError?.message || "Failed to create feedback thread" };
  }

  // Insert initial message
  const { data: msg, error: msgError } = await supabase
    .from("feedback_messages")
    .insert({
      thread_id: thread.id,
      sender_role: "submitter",
      body: trimmedBody,
    })
    .select("id")
    .single();

  if (msgError || !msg) {
    return { ok: false, error: msgError?.message || "Failed to record feedback message" };
  }

  // Notification for Management
  // If safety_concern: trigger urgent alert in notifications table for management users
  const isSafety = category === "safety_concern";
  const notifTitle = isSafety
    ? "🚨 Urgent: Safety Concern Feedback Submitted"
    : "💬 New Staff Feedback Received";
  const notifBody = isSafety
    ? `An urgent safety concern has been submitted anonymously: "${trimmedBody.slice(0, 100)}..."`
    : `New feedback (${category.replace("_", " ")}): "${trimmedBody.slice(0, 100)}..."`;

  // Find all management profiles in the org
  const { data: managers } = await supabase
    .from("profiles")
    .select("id")
    .in("role", ["MANAGEMENT", "ADMIN"]);

  if (managers && managers.length > 0) {
    const notifs = managers.map((m) => ({
      user_id: m.id,
      title: notifTitle,
      body: notifBody,
      is_read: false,
    }));
    await supabase.from("notifications").insert(notifs);
  }

  revalidatePath("/avsec/feedback");
  revalidatePath("/avsec/management/feedback");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/");

  return { ok: true, threadId: thread.id, messageId: msg.id };
}

/**
 * Send a reply message in an existing feedback thread.
 */
export async function sendFeedbackMessage({
  threadId,
  body,
}: {
  threadId: string;
  body: string;
}): Promise<FeedbackActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const trimmedBody = body.trim();
  if (!trimmedBody) return { ok: false, error: "Message cannot be blank." };

  const supabase = await createClient();

  const isManagement = profile.role === "MANAGEMENT" || profile.role === "ADMIN";
  const senderRole = isManagement ? "management" : "submitter";

  const { data: msg, error: msgError } = await supabase
    .from("feedback_messages")
    .insert({
      thread_id: threadId,
      sender_role: senderRole,
      body: trimmedBody,
    })
    .select("id")
    .single();

  if (msgError || !msg) {
    return { ok: false, error: msgError?.message || "Failed to send message" };
  }

  // Update thread updated_at
  await supabase
    .from("feedback_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId);

  // If management replied, notify the submitter
  if (isManagement) {
    const { data: thread } = await supabase
      .from("feedback_threads")
      .select("submitter_id")
      .eq("id", threadId)
      .single();

    if (thread?.submitter_id) {
      await supabase.from("notifications").insert({
        user_id: thread.submitter_id,
        title: "📬 Management Replied to Your Feedback",
        body: `Management has replied: "${trimmedBody.slice(0, 100)}..."`,
        is_read: false,
      });
    }
  }

  revalidatePath("/avsec/feedback");
  revalidatePath("/avsec/management/feedback");
  return { ok: true, messageId: msg.id };
}

/**
 * Update thread status (open / closed).
 */
export async function updateFeedbackStatus({
  threadId,
  status,
}: {
  threadId: string;
  status: FeedbackStatus;
}): Promise<{ ok: boolean; error?: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = await createClient();

  const { error } = await supabase
    .from("feedback_threads")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", threadId);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/avsec/feedback");
  revalidatePath("/avsec/management/feedback");
  return { ok: true };
}
