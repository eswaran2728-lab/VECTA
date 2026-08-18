import { createClient } from "@/lib/supabase/server";
import { DUTY_ROLES } from "@/lib/auth";

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
  zone_id: string | null;
  notes: string | null;
  set_by: string;
  updated_at: string;
}

export async function getShifts(): Promise<Shift[]> {
  const supabase = createClient();
  const { data } = await supabase.from("shifts").select("*").order("display_order");
  return (data as Shift[]) ?? [];
}

export async function getStationTeams(station: string): Promise<StationTeam[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("station_teams")
    .select("station, team, display_order")
    .eq("station", station)
    .eq("active", true)
    .order("display_order");
  return (data as StationTeam[]) ?? [];
}

// One row per officer, for the grid's row axis — the underlying schedule stays
// team-level (team_rosters), this is purely a display join.
export async function getRosterOfficers(station: string, search?: string): Promise<RosterOfficer[]> {
  const supabase = createClient();
  let query = supabase
    .from("profiles")
    .select("id, name, staff_no, team")
    .eq("station", station)
    .eq("status", "approved")
    .in("role", DUTY_ROLES);
  if (search?.trim()) query = query.ilike("name", `%${search.trim()}%`);
  const { data } = await query.order("team").order("name");
  return ((data ?? []) as RosterOfficer[]).map((o) => ({ ...o, team: o.team ?? "" }));
}

export async function getRosterWeek(station: string, weekStart: string, weekEnd: string): Promise<RosterCell[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("station, team, roster_date, shift_code, start_time, end_time, zone_id, notes, set_by, updated_at")
    .eq("station", station)
    .gte("roster_date", weekStart)
    .lte("roster_date", weekEnd);
  return (data as RosterCell[]) ?? [];
}
