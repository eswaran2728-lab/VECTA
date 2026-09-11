import { createClient } from "@/lib/supabase/server";
import { todayISODateMY } from "@/lib/avsec/datetime";
import type { AbsenceStatus } from "./absence-logic";

export interface AbsenceNoticeRow {
  id: string;
  org_id?: string | null;
  user_id: string;
  staff_name: string;
  staff_id: string | null;
  role: string;
  station: string | null;
  team: string | null;
  ops_group: string | null;
  shift_code: string | null;
  duty_date: string;
  shift_start_time: string;
  submitted_at: string;
  gap_minutes: number;
  status: AbsenceStatus;
  remarks: string;
  created_at: string;
}

export interface AbsenceSummaryStats {
  totalCount: number;
  greenCount: number;
  redCount: number;
  lateRatePercent: number;
  staffStats: Array<{
    userId: string;
    staffName: string;
    staffId: string | null;
    role: string;
    team: string | null;
    station: string | null;
    opsGroup: string | null;
    totalAbsences: number;
    redCount: number;
    greenCount: number;
  }>;
}

/**
 * Returns today's absence notice for a given user if already submitted.
 */
export async function getTodayAbsenceNotice(
  profileId: string
): Promise<AbsenceNoticeRow | null> {
  const supabase = await createClient();
  const today = todayISODateMY();

  const { data } = await supabase
    .from("absence_notices")
    .select("*")
    .eq("user_id", profileId)
    .eq("duty_date", today)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as AbsenceNoticeRow) ?? null;
}

/**
 * Queries absence notices with optional filters for Management and DSE.
 */
export async function getAbsenceNotices(options?: {
  station?: string;
  team?: string;
  opsGroup?: string;
  status?: "green" | "red" | "all";
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  limit?: number;
}): Promise<AbsenceNoticeRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("absence_notices")
    .select("*")
    .order("submitted_at", { ascending: false });

  if (options?.userId) {
    query = query.eq("user_id", options.userId);
  }
  if (options?.station && options.station !== "all") {
    query = query.eq("station", options.station);
  }
  if (options?.team && options.team !== "all") {
    query = query.eq("team", options.team);
  }
  if (options?.opsGroup && options.opsGroup !== "all") {
    query = query.eq("ops_group", options.opsGroup);
  }
  if (options?.status && options.status !== "all") {
    query = query.eq("status", options.status);
  }
  if (options?.dateFrom) {
    query = query.gte("duty_date", options.dateFrom);
  }
  if (options?.dateTo) {
    query = query.lte("duty_date", options.dateTo);
  }
  if (options?.limit) {
    query = query.limit(options.limit);
  } else {
    query = query.limit(500);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[getAbsenceNotices] query error:", error);
    return [];
  }

  return (data as AbsenceNoticeRow[]) ?? [];
}

/**
 * Computes aggregate summary metrics across absence records for performance evaluation.
 */
export async function getAbsenceSummaryStats(options?: {
  station?: string;
  team?: string;
  opsGroup?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<AbsenceSummaryStats> {
  const notices = await getAbsenceNotices({
    ...options,
    status: "all",
    limit: 1000,
  });

  const totalCount = notices.length;
  const greenCount = notices.filter((n) => n.status === "green").length;
  const redCount = notices.filter((n) => n.status === "red").length;
  const lateRatePercent = totalCount > 0 ? Math.round((redCount / totalCount) * 100) : 0;

  // Aggregate by staff member for performance evaluation
  const staffMap = new Map<
    string,
    {
      userId: string;
      staffName: string;
      staffId: string | null;
      role: string;
      team: string | null;
      station: string | null;
      opsGroup: string | null;
      totalAbsences: number;
      redCount: number;
      greenCount: number;
    }
  >();

  for (const n of notices) {
    let entry = staffMap.get(n.user_id);
    if (!entry) {
      entry = {
        userId: n.user_id,
        staffName: n.staff_name,
        staffId: n.staff_id,
        role: n.role,
        team: n.team,
        station: n.station,
        opsGroup: n.ops_group,
        totalAbsences: 0,
        redCount: 0,
        greenCount: 0,
      };
      staffMap.set(n.user_id, entry);
    }
    entry.totalAbsences += 1;
    if (n.status === "red") entry.redCount += 1;
    if (n.status === "green") entry.greenCount += 1;
  }

  const staffStats = Array.from(staffMap.values()).sort(
    (a, b) => b.redCount - a.redCount || b.totalAbsences - a.totalAbsences
  );

  return {
    totalCount,
    greenCount,
    redCount,
    lateRatePercent,
    staffStats,
  };
}
