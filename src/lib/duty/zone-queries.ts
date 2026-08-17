import { createClient } from "@/lib/supabase/server";
import type { DutyZone } from "./types";

export async function getZonesForStation(station: string): Promise<DutyZone[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("duty_zones")
    .select("id, station, code, name, polygon, center_lat, center_lng, radius_m, active")
    .eq("station", station)
    .order("code");
  return (data as (DutyZone & { active: boolean })[]) ?? [];
}

export async function getZoneById(id: string): Promise<(DutyZone & { active: boolean }) | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("duty_zones")
    .select("id, station, code, name, polygon, center_lat, center_lng, radius_m, active")
    .eq("id", id)
    .maybeSingle();
  return (data as (DutyZone & { active: boolean })) ?? null;
}
