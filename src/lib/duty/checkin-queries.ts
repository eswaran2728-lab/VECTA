import { createClient } from "@/lib/supabase/server";
import { todayISODateMY } from "@/lib/datetime";
import type { DutyZone, TodayRoster, DutyRecordRow } from "./types";

export async function getTodayRoster(station: string, team: string): Promise<TodayRoster | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("shift_code, start_time, end_time, zone_id, notes")
    .eq("station", station)
    .eq("team", team)
    .eq("roster_date", todayISODateMY())
    .maybeSingle();
  return (data as TodayRoster) ?? null;
}

export async function getDutyZone(zoneId: string): Promise<DutyZone | null> {
  const supabase = createClient();
  const { data } = await supabase.from("duty_zones").select("*").eq("id", zoneId).maybeSingle();
  return (data as DutyZone) ?? null;
}

/** The most recent of today's duty records for this shift — profile_id is implied by RLS
 * ("duty own select"), so no explicit filter is needed to scope this to the caller. */
export async function getTodayDutyRecord(profileId: string, shiftCode: string): Promise<DutyRecordRow | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("duty_records")
    .select(
      "id, shift_code, check_in_at, check_in_inside_fence, check_in_accuracy_m, check_out_at, status, late_minutes, late_remark, early_out_minutes, early_out_remark",
    )
    .eq("profile_id", profileId)
    .eq("duty_date", todayISODateMY())
    .eq("shift_code", shiftCode)
    .maybeSingle();
  return (data as DutyRecordRow) ?? null;
}
