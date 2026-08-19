import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/reference-data";

export type DutyMonitorStatus = "checked_in" | "checked_out" | "off" | "no_roster" | "missed" | "pending" | "upcoming";

export interface DutyMonitorRow {
  profileId: string;
  name: string;
  role: UserRole;
  team: string | null;
  shiftCode: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  checkInAt: string | null;
  checkInInsideFence: boolean | null;
  checkOutAt: string | null;
  lateMinutes: number;
  lateRemark: string | null;
  earlyOutMinutes: number;
  earlyOutRemark: string | null;
  status: DutyMonitorStatus;
}

interface ProfileRow {
  id: string;
  name: string;
  role: UserRole;
  team: string | null;
}

interface RosterRow {
  team: string;
  shift_code: string;
  start_time: string | null;
  end_time: string | null;
}

interface DutyRow {
  profile_id: string;
  check_in_at: string | null;
  check_in_inside_fence: boolean | null;
  check_out_at: string | null;
  late_minutes: number;
  late_remark: string | null;
  early_out_minutes: number;
  early_out_remark: string | null;
}

/** Everyone who could be on a shift at this station (ASO/SO/DSE) for one date, matched
 * against that team's roster and any duty_records — the data behind a management-level
 * "who's checked in" view, not scoped to a single team the way the ASO-only SEC014
 * compliance panel is. */
export async function getDutyMonitorRows(station: string, date: string, today: string, team?: string): Promise<DutyMonitorRow[]> {
  const supabase = createClient();

  let profileQuery = supabase
    .from("profiles")
    .select("id, name, role, team")
    .eq("station", station)
    .eq("status", "approved")
    .in("role", ["ASO", "SO", "DSE"]);
  if (team) profileQuery = profileQuery.eq("team", team);

  let rosterQuery = supabase
    .from("team_rosters")
    .select("team, shift_code, start_time, end_time")
    .eq("station", station)
    .eq("roster_date", date);
  if (team) rosterQuery = rosterQuery.eq("team", team);

  let dutyQuery = supabase
    .from("duty_records")
    .select(
      "profile_id, check_in_at, check_in_inside_fence, check_out_at, late_minutes, late_remark, early_out_minutes, early_out_remark",
    )
    .eq("station", station)
    .eq("duty_date", date);
  if (team) dutyQuery = dutyQuery.eq("team", team);

  const [{ data: profiles }, { data: rosterRows }, { data: dutyRows }] = await Promise.all([
    profileQuery,
    rosterQuery,
    dutyQuery,
  ]);

  const rosterByTeam = new Map(((rosterRows as RosterRow[]) ?? []).map((r) => [r.team, r]));
  const dutyByProfile = new Map(((dutyRows as DutyRow[]) ?? []).map((d) => [d.profile_id, d]));

  return ((profiles as ProfileRow[]) ?? [])
    .map((p) => {
      const roster = rosterByTeam.get(p.team ?? "");
      const duty = dutyByProfile.get(p.id);

      let status: DutyMonitorStatus;
      if (duty?.check_out_at) status = "checked_out";
      else if (duty?.check_in_at) status = "checked_in";
      else if (!roster) status = "no_roster";
      else if (roster.shift_code === "OFF") status = "off";
      else if (date < today) status = "missed";
      else if (date === today) status = "pending";
      else status = "upcoming";

      return {
        profileId: p.id,
        name: p.name,
        role: p.role,
        team: p.team,
        shiftCode: roster?.shift_code ?? null,
        scheduledStart: roster?.start_time ?? null,
        scheduledEnd: roster?.end_time ?? null,
        checkInAt: duty?.check_in_at ?? null,
        checkInInsideFence: duty?.check_in_inside_fence ?? null,
        checkOutAt: duty?.check_out_at ?? null,
        lateMinutes: duty?.late_minutes ?? 0,
        lateRemark: duty?.late_remark ?? null,
        earlyOutMinutes: duty?.early_out_minutes ?? 0,
        earlyOutRemark: duty?.early_out_remark ?? null,
        status,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
