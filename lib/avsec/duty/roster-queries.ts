import { createClient } from "@/lib/supabase/server";
import type { LeaveType } from "./absence-logic";

export interface Shift {
  code: string;
  label: string;
  default_start: string | null;
  default_end: string | null;
  color_hex: string | null;
}

export interface RosterOfficer {
  id: string;
  name: string;
  staff_no: string;
  team: string;
}

export interface StationTeam {
  station: string;
  team: string;
  display_order: number;
}

export interface RosterCell {
  station: string;
  team: string;
  roster_date: string;
  shift_code: string;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  set_by: string;
  updated_at: string;
}

export interface ApprovedLeaveRosterItem {
  id: string;
  user_id: string;
  staff_name: string;
  staff_id: string | null;
  station: string | null;
  team: string | null;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  approval_status: string;
}

export async function getShifts(): Promise<Shift[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("shifts").select("*").order("display_order");
  return (data as Shift[]) ?? [];
}

// Canonical team list for a station (org_teams via RPC; empty unless the caller may manage this station's roster).
export async function getStationTeams(station: string): Promise<StationTeam[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("list_roster_teams_secure", { p_station: station });
  return ((data ?? []) as Array<{ team: string; display_order: number }>).map((r) => ({ station, team: r.team, display_order: r.display_order }));
}

// One row per officer, for the grid's row axis -- canonical station-scoped assignments
// via RPC (never another user's legacy role). The underlying schedule stays team-level.
export async function getRosterOfficers(station: string, search?: string): Promise<RosterOfficer[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("list_roster_officers_secure", { p_station: station });
  let rows = ((data ?? []) as Array<{ id: string; name: string; staff_no: string; team: string }>).map((r) => ({
    id: r.id,
    name: r.name,
    staff_no: r.staff_no,
    team: r.team ?? "",
  }));
  if (search?.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  }
  return rows;
}

export async function getRosterWeek(station: string, weekStart: string, weekEnd: string): Promise<RosterCell[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("station, team, roster_date, shift_code, start_time, end_time, notes, set_by, updated_at")
    .eq("station", station)
    .gte("roster_date", weekStart)
    .lte("roster_date", weekEnd);
  return (data as unknown as RosterCell[]) ?? [];
}

/**
 * Fetches all APPROVED leave applications overlapping the given date range for a station.
 * Pending, rejected, and cancelled applications are strictly excluded.
 */
export async function getApprovedLeavesForRoster(
  station: string,
  weekStart: string,
  weekEnd: string
): Promise<ApprovedLeaveRosterItem[]> {
  const supabase = await createClient();
  let query = supabase
    .from("absence_notices")
    .select("id, user_id, staff_name, staff_id, station, team, leave_type, start_date, end_date, approval_status")
    .eq("approval_status", "approved")
    .lte("start_date", weekEnd)
    .gte("end_date", weekStart);

  if (station) {
    query = query.eq("station", station);
  }

  const { data } = await query;
  return (data as ApprovedLeaveRosterItem[]) ?? [];
}

