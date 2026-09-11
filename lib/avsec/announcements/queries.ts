import { createClient } from "@/lib/supabase/server";
import type {
  AnnouncementRow,
  AnnouncementTargetRow,
  AnnouncementWithStatus,
  ManagementAnnouncementView,
  Profile,
} from "@/lib/avsec/types";

/**
 * Fetch announcements targeting the given profile, with acknowledgement status.
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

  // Fetch all announcements with their target specifications
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
  const isManagement = normalizedRole === "MANAGEMENT" || normalizedRole === "ADMIN" || normalizedRole === "SUPER_ADMIN" || profile.role === "management" || profile.role === "admin";

  // Filter announcements targeting this user
  const matching: AnnouncementWithStatus[] = [];

  for (const a of announcements as AnnouncementRow[]) {
    const tList = targetMap.get(a.id) || [];
    // If no explicit targets or user is management, they can see it
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

  const ackMap = new Map<string, Array<{
    user_id: string;
    name: string;
    role: string;
    station: string | null;
    team: string | null;
    acknowledged_at: string;
  }>>();

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

    // Calculate targeted audience from profiles
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
