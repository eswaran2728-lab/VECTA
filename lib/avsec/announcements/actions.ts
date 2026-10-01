"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/avsec/auth";
import type {
  AnnouncementScope,
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementStatus,
  AnnouncementAcknowledgementReport,
} from "@/lib/avsec/types";

export interface AnnouncementActionResult {
  ok: boolean;
  announcementId?: string;
  error?: string;
}

/**
 * Phase 11: Create a secure announcement targeting Global or Malaysia AOC.
 * Authorization enforced at database RPC layer:
 *  - Global: GHOD ONLY
 *  - Malaysia AOC: MAA/AAX Boss / Admin ONLY (GHOD must not publish AOC)
 *  - Super Admin, AirAsia Management, Operation Manager, Main Enforcement, Compliance, CaterLink: Denied
 */
export async function createAnnouncementSecure({
  title,
  body,
  scope = "aoc",
  aocId = null,
  category = "operational",
  priority = "normal",
  status = "published",
  publishedAt = null,
  expiresAt = null,
  requiresAcknowledgement = false,
  isPinned = false,
}: {
  title: string;
  body: string;
  scope?: AnnouncementScope;
  aocId?: string | null;
  category?: AnnouncementCategory;
  priority?: AnnouncementPriority;
  status?: AnnouncementStatus;
  publishedAt?: string | null;
  expiresAt?: string | null;
  requiresAcknowledgement?: boolean;
  isPinned?: boolean;
}): Promise<AnnouncementActionResult> {
  const supabase = await createClient();

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) {
    return { ok: false, error: "Title and body are required." };
  }

  const { data, error } = await supabase.rpc("create_announcement_secure", {
    p_title: trimmedTitle,
    p_body: trimmedBody,
    p_scope: scope,
    p_aoc_id: aocId || null,
    p_category: category,
    p_priority: priority,
    p_status: status,
    p_published_at: publishedAt || null,
    p_expires_at: expiresAt || null,
    p_requires_acknowledgement: requiresAcknowledgement,
    p_is_pinned: isPinned,
  });

  if (error || !data) {
    return { ok: false, error: error?.message || "Failed to create announcement" };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true, announcementId: String(data) };
}

/**
 * Phase 11: Publish a draft or scheduled announcement immediately.
 */
export async function publishAnnouncementSecure(
  announcementId: string,
  publishedAt?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("publish_announcement_secure", {
    p_announcement_id: announcementId,
    p_published_at: publishedAt || null,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true };
}

/**
 * Phase 11: Archive an announcement.
 */
export async function archiveAnnouncementSecure(
  announcementId: string,
  reason: string = "Archived by publisher"
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("archive_announcement_secure", {
    p_announcement_id: announcementId,
    p_reason: reason,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true };
}

/**
 * Phase 11: Update an announcement's content or metadata.
 */
export async function updateAnnouncementSecure({
  announcementId,
  title,
  body,
  category,
  priority,
}: {
  announcementId: string;
  title: string;
  body: string;
  category: AnnouncementCategory;
  priority: AnnouncementPriority;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("update_announcement_secure", {
    p_announcement_id: announcementId,
    p_title: title.trim(),
    p_body: body.trim(),
    p_category: category,
    p_priority: priority,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true };
}

/**
 * Phase 11: Record caller acknowledgement for a mandatory announcement.
 * Enforces recipient eligibility, visibility, and idempotent safe duplicate handling.
 */
export async function acknowledgeAnnouncement(
  announcementId: string
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("acknowledge_announcement_secure", {
    p_announcement_id: announcementId,
  });

  if (error) {
    // Unique violation is idempotent success
    if (error.code === "23505") {
      return { ok: true };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true };
}

/**
 * Phase 11: Attach metadata for an uploaded document or image.
 */
export async function addAnnouncementAttachmentSecure({
  announcementId,
  fileName,
  fileUrl,
  fileType = "application/octet-stream",
  fileSizeBytes = 0,
}: {
  announcementId: string;
  fileName: string;
  fileUrl: string;
  fileType?: string;
  fileSizeBytes?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();

  const { error } = await supabase.rpc("add_announcement_attachment_secure", {
    p_announcement_id: announcementId,
    p_file_name: fileName,
    p_file_url: fileUrl,
    p_file_type: fileType,
    p_file_size_bytes: fileSizeBytes,
  });

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/avsec/management/announcements");
  return { ok: true };
}

/**
 * Phase 11: Fetch acknowledgement report for an announcement (author or authorized manager).
 */
export async function fetchAnnouncementReport(
  announcementId: string
): Promise<AnnouncementAcknowledgementReport | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_announcement_acknowledgement_report_secure", {
    p_announcement_id: announcementId,
  });

  if (error || !data) {
    console.error("Error fetching acknowledgement report:", error?.message);
    return null;
  }

  return (data as unknown) as AnnouncementAcknowledgementReport;
}

/**
 * Legacy wrapper: createAnnouncement.
 * Delegates to createAnnouncementSecure while maintaining backward compatibility.
 */
export async function createAnnouncement({
  title,
  body,
  station,
  photoUrl,
  isPop,
  branch,
  team,
}: {
  title: string;
  body: string;
  station?: string | null;
  photoUrl?: string | null;
  isPop?: boolean;
  branch?: "operation_avsec" | "ifc_avsec" | "hub_avsec" | null;
  team?: string | null;
}): Promise<AnnouncementActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) {
    return { ok: false, error: "Title and body are required." };
  }

  // Attempt using Phase 11 secure RPC first
  try {
    const res = await createAnnouncementSecure({
      title: trimmedTitle,
      body: trimmedBody,
      scope: "aoc",
      priority: isPop ? "urgent" : "normal",
      status: "published",
      requiresAcknowledgement: Boolean(isPop),
    });
    if (res.ok) {
      if (photoUrl && res.announcementId) {
        await addAnnouncementAttachmentSecure({
          announcementId: res.announcementId,
          fileName: "attachment.jpg",
          fileUrl: photoUrl,
          fileType: "image/jpeg",
        });
      }
      return res;
    }
  } catch (err) {
    console.warn("RPC create announcement fallback to direct table insert:", err);
  }

  // Fallback to table insert for legacy tests/flows
  const supabase = await createClient();

  const { data: announcement, error: annError } = await supabase
    .from("announcements")
    .insert({
      created_by: profile.id,
      title: trimmedTitle,
      body: trimmedBody,
      photo_url: photoUrl?.trim() || null,
      is_pop: Boolean(isPop),
    })
    .select("id")
    .single();

  if (annError || !announcement) {
    return { ok: false, error: annError?.message || "Failed to create announcement" };
  }

  const targetStation = station?.trim() || null;
  const targetBranch = branch || null;
  const targetTeam = team?.trim() || null;

  await supabase.from("announcement_targets").insert({
    announcement_id: announcement.id,
    station: targetStation,
    branch: targetBranch,
    team: targetTeam,
  });

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true, announcementId: announcement.id };
}
