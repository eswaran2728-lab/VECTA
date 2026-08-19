import { createClient } from "@/lib/supabase/server";
import type { TimesheetRosterDay, TimesheetDutyRecord, DutyRecordDetail } from "./types";

export async function getTimesheetRoster(
  station: string,
  team: string,
  weekStart: string,
  weekEnd: string,
): Promise<TimesheetRosterDay[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("roster_date, shift_code, start_time, end_time, zone_id")
    .eq("station", station)
    .eq("team", team)
    .gte("roster_date", weekStart)
    .lte("roster_date", weekEnd);
  return (data as TimesheetRosterDay[]) ?? [];
}

export async function getTimesheetDuty(
  profileId: string,
  weekStart: string,
  weekEnd: string,
): Promise<TimesheetDutyRecord[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("duty_records")
    .select(
      "id, shift_code, duty_date, check_in_at, check_in_inside_fence, check_in_accuracy_m, check_out_at, status, late_minutes, late_remark, early_out_minutes, early_out_remark",
    )
    .eq("profile_id", profileId)
    .gte("duty_date", weekStart)
    .lte("duty_date", weekEnd);
  return (data as TimesheetDutyRecord[]) ?? [];
}

/** RLS scopes this to records the caller may see (own, or monitor within rank/station/team). */
export async function getDutyRecordDetail(id: string): Promise<DutyRecordDetail | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("duty_records").select("*").eq("id", id).maybeSingle();
  return (data as DutyRecordDetail) ?? null;
}
