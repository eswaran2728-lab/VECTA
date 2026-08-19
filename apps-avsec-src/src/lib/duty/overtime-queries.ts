import { createClient } from "@/lib/supabase/server";
import { scheduledWindow } from "./lateness";
import { calcOtHours } from "./overtime";

export interface OvertimeRequestRow {
  id: string;
  profile_id: string;
  station: string;
  team: string | null;
  work_date: string;
  shift_code: string | null;
  start_at: string;
  end_at: string;
  hours: number;
  payable_hours: number;
  category: string;
  reason: string;
  status: string;
  endorsed_by: string | null;
  endorsed_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  linked_duty_id: string | null;
  created_at: string;
}

const ROW_FIELDS =
  "id, profile_id, station, team, work_date, shift_code, start_at, end_at, hours, payable_hours, category, reason, status, endorsed_by, endorsed_at, approved_by, approved_at, rejection_reason, linked_duty_id, created_at";

/** RLS returns the union of the caller's own requests plus anything they may monitor
 * (rank above submitter, same station+team or org-wide) — same shape as report visibility. */
export async function getVisibleOvertimeRequests(): Promise<OvertimeRequestRow[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("overtime_requests")
    .select(ROW_FIELDS)
    .order("created_at", { ascending: false })
    .limit(200);
  return (data as OvertimeRequestRow[]) ?? [];
}

export async function getOvertimeRequestById(id: string): Promise<OvertimeRequestRow | null> {
  const supabase = createClient();
  const { data } = await supabase.from("overtime_requests").select(ROW_FIELDS).eq("id", id).maybeSingle();
  return (data as OvertimeRequestRow) ?? null;
}

export interface RosterDay {
  shift_code: string;
  start_time: string | null;
  end_time: string | null;
}

/** Used to auto-suggest the "off_day_work" category when the chosen OT date is a
 * rostered OFF day. */
export async function getRosterForDate(station: string, team: string, date: string): Promise<RosterDay | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("shift_code, start_time, end_time")
    .eq("station", station)
    .eq("team", team)
    .eq("roster_date", date)
    .maybeSingle();
  return (data as RosterDay) ?? null;
}

export interface SuggestedShift {
  duty_id: string;
  duty_date: string;
  shift_code: string;
  check_out_at: string;
  scheduled_end: string;
  suggested_hours: number;
}

/** Own completed shifts (checked out) in the last 14 days whose check-out ran past the
 * roster's scheduled end — pre-fill candidates for "link to a completed shift". */
export async function getSuggestedOvertimeShifts(
  profileId: string,
  station: string,
  team: string,
): Promise<SuggestedShift[]> {
  const supabase = createClient();
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [{ data: dutyRows }, { data: rosterRows }] = await Promise.all([
    supabase
      .from("duty_records")
      .select("id, duty_date, shift_code, check_out_at")
      .eq("profile_id", profileId)
      .not("check_out_at", "is", null)
      .gte("duty_date", since)
      .order("duty_date", { ascending: false }),
    supabase
      .from("team_rosters")
      .select("roster_date, start_time, end_time")
      .eq("station", station)
      .eq("team", team)
      .gte("roster_date", since),
  ]);

  const rosterByDate = new Map((rosterRows ?? []).map((r) => [r.roster_date, r]));

  const suggestions: SuggestedShift[] = [];
  for (const duty of dutyRows ?? []) {
    const roster = rosterByDate.get(duty.duty_date);
    if (!roster?.start_time || !roster?.end_time || !duty.check_out_at) continue;
    const { end } = scheduledWindow(duty.duty_date, roster.start_time, roster.end_time);
    const checkOut = new Date(duty.check_out_at);
    const hours = calcOtHours(end, checkOut);
    if (hours <= 0) continue;
    suggestions.push({
      duty_id: duty.id,
      duty_date: duty.duty_date,
      shift_code: duty.shift_code,
      check_out_at: duty.check_out_at,
      scheduled_end: end.toISOString(),
      suggested_hours: hours,
    });
  }
  return suggestions;
}
