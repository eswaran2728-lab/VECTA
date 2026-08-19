import { createClient } from "@/lib/avsec/supabase/server";
import type { DutyZone } from "./types";

export async function getZonesForStation(station: string): Promise<(DutyZone & { active: boolean })[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("duty_zones")
    .select("id, station, code, name, polygon, center_lat, center_lng, radius_m, active")
    .eq("station", station)
    .order("code");
  return (data as (DutyZone & { active: boolean })[]) ?? [];
}

export async function getZoneById(id: string): Promise<(DutyZone & { active: boolean }) | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("duty_zones")
    .select("id, station, code, name, polygon, center_lat, center_lng, radius_m, active")
    .eq("id", id)
    .maybeSingle();
  return (data as (DutyZone & { active: boolean })) ?? null;
}
