import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AnnouncementAcknowledgementReport,
  AnnouncementItem,
  AnnouncementWithStatus,
  ManagementAnnouncementView,
} from "@/lib/avsec/types";

/**
 * Canonical announcement reads. Every read goes through the Phase 11 security-definer RPCs, which decide visibility (AOC / global scope,
 * scheduling, expiry, audience) and acknowledgement privacy in the database. A secure RPC that succeeds with ZERO rows means "nothing is
 * visible to this caller": it is never a reason to query a legacy table. An RPC error fails closed (no announcements), never open.
 */
type Rpc = Pick<SupabaseClient, "rpc">;

export async function activeAnnouncementsFor(supabase: Rpc): Promise<AnnouncementWithStatus[]> {
  try {
    const { data, error } = await supabase.rpc("get_visible_announcements_secure", { p_scope: null, p_category: null, p_include_archived: false });
    if (error || !Array.isArray(data)) return [];
    return (data as unknown as AnnouncementItem[]).map((item) => ({
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
  } catch {
    return [];
  }
}

const MAX_MANAGEABLE = 50;

/** Management view: the manageable announcements and, per announcement, the secure acknowledgement report (author / authorised manager only). */
export async function managementAnnouncementsFrom(supabase: Rpc): Promise<ManagementAnnouncementView[]> {
  let items: AnnouncementItem[] = [];
  try {
    const { data, error } = await supabase.rpc("list_manageable_announcements_secure");
    if (error || !Array.isArray(data)) return [];
    items = (data as unknown as AnnouncementItem[]).slice(0, MAX_MANAGEABLE);
  } catch {
    return [];
  }

  return Promise.all(
    items.map(async (item): Promise<ManagementAnnouncementView> => {
      let report: AnnouncementAcknowledgementReport | null = null;
      try {
        const { data, error } = await supabase.rpc("get_announcement_acknowledgement_report_secure", { p_announcement_id: item.id });
        if (!error && data && typeof data === "object") report = data as unknown as AnnouncementAcknowledgementReport;
      } catch {
        report = null;
      }
      return {
        id: item.id,
        org_id: null,
        created_by: "",
        title: item.title,
        body: item.body,
        photo_url: null,
        is_pop: item.priority === "urgent",
        created_at: item.created_at,
        targets: [],
        total_target_users: report?.total_eligible ?? 0,
        acknowledged_count: report?.total_acknowledged ?? 0,
        acknowledgements: (report?.acknowledged_staff ?? []).map((s) => ({
          user_id: s.profile_id,
          name: s.name,
          role: s.department ?? "",
          station: s.station,
          team: null,
          acknowledged_at: s.acknowledged_at,
        })),
        pending_users: (report?.pending_staff ?? []).map((s) => ({
          user_id: s.profile_id,
          name: s.name,
          role: s.department ?? "",
          station: s.station,
          team: null,
        })),
      };
    }),
  );
}
