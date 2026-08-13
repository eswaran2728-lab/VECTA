import { createClient } from "@/lib/supabase/server";

export interface Shift {
  code: string;
  label: string;
  default_start: string | null;
  default_end: string | null;
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

export async function getRosterWeek(station: string, weekStart: string, weekEnd: string): Promise<RosterCell[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("station, team, roster_date, shift_code, start_time, end_time, notes, set_by, updated_at")
    .eq("station", station)
    .gte("roster_date", weekStart)
    .lte("roster_date", weekEnd);
  return (data as RosterCell[]) ?? [];
}
