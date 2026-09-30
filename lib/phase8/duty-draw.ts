"use server";

import { createClient } from "@/lib/supabase/server";

export interface Phase8ActionResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

export async function initiateDutyDraw(station: string, drawDate: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("initiate_duty_draw_secure", { p_station: station, p_draw_date: drawDate });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0]?.row_id ?? null } satisfies Phase8ActionResult<string>;
}

export async function recordDutyDrawAssignment(drawId: string, profileId: string, zoneId: string | null) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_duty_draw_assignment_secure", { p_draw_id: drawId, p_profile_id: profileId, p_zone_id: zoneId });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: undefined } satisfies Phase8ActionResult;
}

export async function finalizeDutyDraw(drawId: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("finalize_duty_draw_secure", { p_draw_id: drawId });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: undefined } satisfies Phase8ActionResult;
}

export async function getDutyDraw(station: string, drawDate: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_duty_draw_secure", { p_station: station, p_draw_date: drawDate });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listDutyDrawHistory(station: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_duty_draw_history_secure", { p_station: station });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listStationStaffForDraw(station: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_station_staff_for_draw_secure", { p_station: station });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export interface DutyZoneOption {
  id: string;
  code: string;
  name: string;
}

export async function listDutyZonesForStation(station: string): Promise<Phase8ActionResult<DutyZoneOption[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("duty_zones").select("id, code, name").eq("station", station).eq("active", true).order("code");
  if (error) return { ok: false, error: error.message, data: null };
  return { ok: true, error: null, data: data ?? [] };
}
