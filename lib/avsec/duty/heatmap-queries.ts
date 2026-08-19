import { createClient } from "@/lib/avsec/supabase/server";

export interface HeatmapFilters {
  team?: string;
  shift?: string;
  zone?: string;
}

export interface DutyPoint {
  id: string;
  profile_id: string;
  name: string;
  team: string | null;
  shift_code: string;
  zone_id: string | null;
  lat: number | null;
  lng: number | null;
  check_in_at: string;
  check_out_at: string | null;
  late_minutes: number;
  early_out_minutes: number;
  duty_date: string;
}

interface DutyPointRaw {
  id: string;
  profile_id: string;
  team: string | null;
  shift_code: string;
  zone_id: string | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  check_in_at: string;
  check_out_at: string | null;
  late_minutes: number;
  early_out_minutes: number;
  duty_date: string;
}

const POINT_FIELDS =
  "id, profile_id, team, shift_code, zone_id, check_in_lat, check_in_lng, check_in_at, check_out_at, late_minutes, early_out_minutes, duty_date";

async function attachNames(rows: DutyPointRaw[]): Promise<DutyPoint[]> {
  const ids = Array.from(new Set(rows.map((r) => r.profile_id)));
  let names = new Map<string, string>();
  if (ids.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase.from("profiles").select("id, name").in("id", ids);
    names = new Map((data ?? []).map((p) => [p.id, p.name]));
  }
  return rows.map((r) => ({
    id: r.id,
    profile_id: r.profile_id,
    name: names.get(r.profile_id) ?? "Unknown",
    team: r.team,
    shift_code: r.shift_code,
    zone_id: r.zone_id,
    lat: r.check_in_lat,
    lng: r.check_in_lng,
    check_in_at: r.check_in_at,
    check_out_at: r.check_out_at,
    late_minutes: r.late_minutes,
    early_out_minutes: r.early_out_minutes,
    duty_date: r.duty_date,
  }));
}

/** Live mode: everyone currently checked in (check_out_at still null) at a station —
 * no periodic ping table needed, this is exactly what /duty check-in already captures. */
export async function getLiveDutyPoints(station: string, filters: HeatmapFilters): Promise<DutyPoint[]> {
  const supabase = await createClient();
  let query = supabase
    .from("duty_records")
    .select(POINT_FIELDS)
    .eq("station", station)
    .not("check_in_at", "is", null)
    .is("check_out_at", null);
  if (filters.team) query = query.eq("team", filters.team);
  if (filters.shift) query = query.eq("shift_code", filters.shift);
  if (filters.zone) query = query.eq("zone_id", filters.zone);

  const { data } = await query;
  return attachNames((data as DutyPointRaw[]) ?? []);
}

/** History mode: replay any past day/range — same duty_records rows, just not
 * restricted to "still open". */
export async function getHistoryDutyPoints(
  station: string,
  from: string,
  to: string,
  filters: HeatmapFilters,
): Promise<DutyPoint[]> {
  const supabase = await createClient();
  let query = supabase
    .from("duty_records")
    .select(POINT_FIELDS)
    .eq("station", station)
    .gte("duty_date", from)
    .lte("duty_date", to)
    .not("check_in_at", "is", null);
  if (filters.team) query = query.eq("team", filters.team);
  if (filters.shift) query = query.eq("shift_code", filters.shift);
  if (filters.zone) query = query.eq("zone_id", filters.zone);

  const { data } = await query;
  return attachNames((data as DutyPointRaw[]) ?? []);
}

export interface RosterWindow {
  team: string;
  roster_date: string;
  start_time: string | null;
  end_time: string | null;
}

/** Used to compute History mode's "total OT hours" zone total — same floor-to-whole-hour
 * rule as /duty/overtime, applied against each record's scheduled shift end. */
export async function getRostersForRange(station: string, from: string, to: string): Promise<RosterWindow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("team_rosters")
    .select("team, roster_date, start_time, end_time")
    .eq("station", station)
    .gte("roster_date", from)
    .lte("roster_date", to);
  return (data as RosterWindow[]) ?? [];
}
