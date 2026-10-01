import { createClient } from "@/lib/supabase/server";
import type {
  AnnouncementRow,
  AnnouncementTargetRow,
  AnnouncementWithStatus,
  ManagementAnnouncementView,
  AnnouncementItem,
  AnnouncementDetail,
  AnnouncementAttachment,
  AnnouncementAcknowledgementReport,
  AnnouncementScope,
  AnnouncementCategory,
  Profile,
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
 * Fetch announcements targeting the given profile, with acknowledgement status.
 * Backwards compatible: uses get_visible_announcements_secure first, falls back gracefully.
 */
export async function getActiveAnnouncementsForUser(
  profile: {
    id: string;
    role?: string | null;
    station?: string | null;
    team?: string | null;
    ops_group?: string | null;
  }
): Promise<AnnouncementWithStatus[]> {
  const supabase = await createClient();

  // Try the Phase 11 secure RPC first
  try {
    const { data: rpcItems, error: rpcError } = await supabase.rpc(
      "get_visible_announcements_secure",
      { p_scope: null, p_category: null, p_include_archived: false }
    );

    if (!rpcError && rpcItems && Array.isArray(rpcItems) && rpcItems.length > 0) {
      return ((rpcItems as unknown) as AnnouncementItem[]).map((item) => ({
        id: item.id,
        org_id: null,
        created_by: "",
        title: item.title,
        body: item.body,
        photo_url: null,
        is_pop: item.priority === "urgent",
        created_at: item.created_at,
        targets: [],
        acknowledged: item.acknowledged,
        acknowledged_at: item.acknowledged_at,
      }));
    }
  } catch (err) {
    console.warn("Falling back to table query for announcements:", err);
  }

  // Fallback to table query for legacy schemas/tests
  const { data: announcements } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });

  if (!announcements || announcements.length === 0) return [];

  const annIds = announcements.map((a) => a.id);

  const [{ data: targets }, { data: acks }] = await Promise.all([
    supabase.from("announcement_targets").select("*").in("announcement_id", annIds),
    supabase
      .from("announcement_acknowledgements")
      .select("*")
      .eq("user_id", profile.id)
      .in("announcement_id", annIds),
  ]);

  const targetMap = new Map<string, AnnouncementTargetRow[]>();
  (targets ?? []).forEach((t) => {
    const list = targetMap.get(t.announcement_id) || [];
    list.push(t as AnnouncementTargetRow);
    targetMap.set(t.announcement_id, list);
  });

  const ackMap = new Map<string, string>();
  (acks ?? []).forEach((a) => {
    ackMap.set(a.announcement_id, a.acknowledged_at);
  });

  const normalizedRole = profile.role?.toUpperCase();
  const isManagement =
    normalizedRole === "MANAGEMENT" ||
    normalizedRole === "ADMIN" ||
    normalizedRole === "SUPER_ADMIN" ||
    profile.role === "management" ||
    profile.role === "admin";

  const matching: AnnouncementWithStatus[] = [];

  for (const a of announcements as AnnouncementRow[]) {
    const tList = targetMap.get(a.id) || [];
    let matches = isManagement;

    if (!matches) {
      if (tList.length === 0) {
        matches = true;
      } else {
        matches = tList.some((t) => {
          const branchMatch = !t.branch || t.branch === profile.ops_group;
          const stationMatch = !t.station || t.station === profile.station;
          const teamMatch = !t.team || t.team === profile.team;
          return branchMatch && stationMatch && teamMatch;
        });
      }
    }

    if (matches) {
      const ackTime = ackMap.get(a.id) ?? null;
      matching.push({
        ...a,
        targets: tList,
        acknowledged: ackTime !== null,
        acknowledged_at: ackTime,
      });
    }
  }

  return matching;
}

/**
 * Fetch all announcements for Management with target reach and acknowledgement audit lists.
 */
export async function getManagementAnnouncements(): Promise<ManagementAnnouncementView[]> {
  const supabase = await createClient();

  const { data: announcements } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });

  if (!announcements || announcements.length === 0) return [];

  const annIds = announcements.map((a) => a.id);

  const [{ data: targets }, { data: acks }, { data: profiles }] = await Promise.all([
    supabase.from("announcement_targets").select("*").in("announcement_id", annIds),
    supabase
      .from("announcement_acknowledgements")
      .select("announcement_id, user_id, acknowledged_at, profiles(name, role, station, team)")
      .in("announcement_id", annIds),
    supabase.from("profiles").select("id, name, role, ops_group, station, team"),
  ]);

  const targetMap = new Map<string, AnnouncementTargetRow[]>();
  (targets ?? []).forEach((t) => {
    const list = targetMap.get(t.announcement_id) || [];
    list.push(t as AnnouncementTargetRow);
    targetMap.set(t.announcement_id, list);
  });

  const ackMap = new Map<
    string,
    Array<{
      user_id: string;
      name: string;
      role: string;
      station: string | null;
      team: string | null;
      acknowledged_at: string;
    }>
  >();

  (acks ?? []).forEach((a: Record<string, unknown>) => {
    const annId = String(a.announcement_id);
    const p = (a.profiles as Record<string, unknown>) || {};
    const list = ackMap.get(annId) || [];
    list.push({
      user_id: String(a.user_id),
      name: String(p.name || "Staff"),
      role: String(p.role || "ASO"),
      station: (p.station as string | null) ?? null,
      team: (p.team as string | null) ?? null,
      acknowledged_at: String(a.acknowledged_at),
    });
    ackMap.set(annId, list);
  });

  const allProfiles = (profiles ?? []) as Profile[];

  return (announcements as AnnouncementRow[]).map((a) => {
    const tList = targetMap.get(a.id) || [];
    const acked = ackMap.get(a.id) || [];
    const ackedUserIds = new Set(acked.map((x) => x.user_id));

    const targetedUsers = allProfiles.filter((p) => {
      if (tList.length === 0) return true;
      return tList.some((t) => {
        const branchMatch = !t.branch || t.branch === p.ops_group;
        const stationMatch = !t.station || t.station === p.station;
        const teamMatch = !t.team || t.team === p.team;
        return branchMatch && stationMatch && teamMatch;
      });
    });

    const pendingUsers = targetedUsers
      .filter((p) => !ackedUserIds.has(p.id))
      .map((p) => ({
        user_id: p.id,
        name: p.name,
        role: p.role,
        station: p.station,
        team: p.team,
      }));

    return {
      ...a,
      targets: tList,
      total_target_users: targetedUsers.length,
      acknowledged_count: acked.length,
      acknowledgements: acked,
      pending_users: pendingUsers,
    };
  });
}
