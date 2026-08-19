import { createClient } from "@/lib/supabase/server";

export interface DutyComplianceEntry {
  checkedIn: boolean;
  status: string;
  checkInAt: string | null;
  lateMinutes: number;
  lateRemark: string | null;
  earlyOutMinutes: number;
  earlyOutRemark: string | null;
}

/** Feeds the dashboard's Shift compliance panel a second column (CHECKED-IN /
 * NOT CHECKED-IN) alongside the existing SEC 014 SUBMITTED/MISSING one — same officer
 * list, same station+team scoping, just a different data source. */
export async function getDutyComplianceForDate(
  station: string,
  date: string,
  team?: string,
): Promise<Map<string, DutyComplianceEntry>> {
  const supabase = createClient();
  let query = supabase
    .from("duty_records")
    .select("profile_id, status, check_in_at, late_minutes, late_remark, early_out_minutes, early_out_remark")
    .eq("station", station)
    .eq("duty_date", date);
  if (team) query = query.eq("team", team);
  const { data } = await query;

  const map = new Map<string, DutyComplianceEntry>();
  for (const row of data ?? []) {
    map.set(row.profile_id, {
      checkedIn: !!row.check_in_at,
      status: row.status,
      checkInAt: row.check_in_at,
      lateMinutes: row.late_minutes,
      lateRemark: row.late_remark,
      earlyOutMinutes: row.early_out_minutes,
      earlyOutRemark: row.early_out_remark,
    });
  }
  return map;
}
