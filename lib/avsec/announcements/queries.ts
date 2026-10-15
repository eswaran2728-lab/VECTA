import { createClient } from "@/lib/supabase/server";
import { activeAnnouncementsFor, managementAnnouncementsFrom } from "./canonical";
import type {
  AnnouncementWithStatus,
  ManagementAnnouncementView,
  AnnouncementItem,
  AnnouncementDetail,
  AnnouncementAttachment,
  AnnouncementAcknowledgementReport,
  AnnouncementScope,
  AnnouncementCategory,
} from "@/lib/avsec/types";

/**
 * Phase 11: Fetch all visible announcements for the authenticated caller via secure RPC.
 * Respects strict multi-AOC isolation, global announcements, scheduling, and expiry.
 */
export async function getVisibleAnnouncements(
  scope?: AnnouncementScope | null,
  category?: AnnouncementCategory | null,
  includeArchived: boolean = false
): Promise<AnnouncementItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_visible_announcements_secure", {
    p_scope: scope || null,
    p_category: category || null,
    p_include_archived: includeArchived,
  });

  if (error) {
    console.error("Error fetching visible announcements:", error.message);
    return [];
  }

  return ((data as unknown) as AnnouncementItem[]) || [];
}

/**
 * Phase 11: Fetch detailed information for a single announcement via secure RPC.
 * Raises not found if announcement is not visible to caller.
 */
export async function getAnnouncementDetail(
  announcementId: string
): Promise<AnnouncementDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_announcement_detail_secure", {
    p_announcement_id: announcementId,
  });

  if (error || !data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return ((data[0] as unknown) as AnnouncementDetail) || null;
}

/**
 * Phase 11: Fetch metadata for attachments on a visible announcement.
 */
export async function getAnnouncementAttachments(
  announcementId: string
): Promise<AnnouncementAttachment[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_announcement_attachments_secure", {
    p_announcement_id: announcementId,
  });

  if (error) {
    console.error("Error fetching announcement attachments:", error.message);
    return [];
  }

  return ((data as unknown) as AnnouncementAttachment[]) || [];
}

/**
 * Phase 11: Fetch acknowledgement report for an announcement (author or authorized manager).
 */
export async function getAnnouncementReport(
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
 * Phase 11: List drafts, scheduled, and published announcements manageable by current user.
 */
export async function listManageableAnnouncements(): Promise<AnnouncementItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_manageable_announcements_secure");

  if (error) {
    console.error("Error listing manageable announcements:", error.message);
    return [];
  }

  return ((data as unknown) as AnnouncementItem[]) || [];
}

/**
 * Fetch announcements for the signed-in user with acknowledgement status. The Phase 11 secure RPC is the only source: an empty result
 * means nothing is visible to this caller, and an error fails closed (see ./canonical.ts). The profile is accepted for call-site
 * compatibility; visibility is decided in the database from the caller's session, never from client-supplied role/station/team.
 */
export async function getActiveAnnouncementsForUser(
  _profile: { id: string; role?: string | null; station?: string | null; team?: string | null }
): Promise<AnnouncementWithStatus[]> {
  return activeAnnouncementsFor(await createClient());
}

/**
 * Management view: manageable announcements with their secure acknowledgement reports (author or authorised manager only; the report
 * RPC enforces AOC isolation and acknowledgement privacy).
 */
export async function getManagementAnnouncements(): Promise<ManagementAnnouncementView[]> {
  return managementAnnouncementsFrom(await createClient());
}
