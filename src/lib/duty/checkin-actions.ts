"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { todayISODateMY } from "@/lib/datetime";
import { pointInPolygon } from "./geofence";
import { scheduledWindow, computeLateMinutes, computeEarlyMinutes } from "./lateness";
import type { DutyZone } from "./types";

export interface ActionResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface CheckInInput {
  lat: number;
  lng: number;
  accuracy_m: number;
  late_remark: string;
}

// Re-derives everything authoritative from the DB (roster, zone) rather than trusting
// client-supplied values — the client's fence/lateness verdict is UI feedback only.
export async function submitDutyCheckIn(input: CheckInInput): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station) return { ok: false, error: "Not authenticated" };

  const supabase = createClient();
  const dutyDate = todayISODateMY();

  const { data: roster } = await supabase
    .from("team_rosters")
    .select("shift_code, start_time, end_time, zone_id")
    .eq("station", profile.station)
    .eq("team", profile.team ?? "")
    .eq("roster_date", dutyDate)
    .maybeSingle();

  if (!roster) return { ok: false, error: "No roster set for today — contact your supervisor." };

  let insideFence: boolean | null = null;
  if (roster.zone_id) {
    const { data: zone } = await supabase.from("duty_zones").select("*").eq("id", roster.zone_id).maybeSingle();
    if (zone) insideFence = pointInPolygon(input.lng, input.lat, (zone as DutyZone).polygon);
  }

  let lateMinutes = 0;
  const now = new Date();
  if (roster.start_time && roster.end_time && roster.shift_code !== "OFF") {
    const { start } = scheduledWindow(dutyDate, roster.start_time, roster.end_time);
    lateMinutes = computeLateMinutes(start, now);
  }

  if (lateMinutes > 0 && !input.late_remark.trim()) {
    return { ok: false, error: "A remark is required — you're checking in late." };
  }

  const { data, error } = await supabase
    .from("duty_records")
    .insert({
      profile_id: profile.id,
      station: profile.station,
      team: profile.team || null,
      duty_date: dutyDate,
      shift_code: roster.shift_code,
      zone_id: roster.zone_id,
      check_in_at: now.toISOString(),
      check_in_lat: input.lat,
      check_in_lng: input.lng,
      check_in_accuracy_m: input.accuracy_m,
      check_in_inside_fence: insideFence,
      status: lateMinutes > 0 ? "late" : "present",
      late_minutes: lateMinutes,
      late_remark: lateMinutes > 0 ? input.late_remark.trim() : null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/duty");
  revalidatePath("/home");
  return { ok: true, id: data.id };
}

export interface CheckOutInput {
  lat: number;
  lng: number;
  early_out_remark: string;
}

export async function submitDutyCheckOut(input: CheckOutInput): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station) return { ok: false, error: "Not authenticated" };

  const supabase = createClient();
  const dutyDate = todayISODateMY();

  const { data: record } = await supabase
    .from("duty_records")
    .select("id, zone_id")
    .eq("profile_id", profile.id)
    .eq("duty_date", dutyDate)
    .is("check_out_at", null)
    .not("check_in_at", "is", null)
    .order("check_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) return { ok: false, error: "No open check-in found for today." };

  const { data: roster } = await supabase
    .from("team_rosters")
    .select("start_time, end_time")
    .eq("station", profile.station)
    .eq("team", profile.team ?? "")
    .eq("roster_date", dutyDate)
    .maybeSingle();

  let earlyMinutes = 0;
  const now = new Date();
  if (roster?.start_time && roster?.end_time) {
    const { end } = scheduledWindow(dutyDate, roster.start_time, roster.end_time);
    earlyMinutes = computeEarlyMinutes(end, now);
  }

  if (earlyMinutes > 0 && !input.early_out_remark.trim()) {
    return { ok: false, error: "A remark is required — you're leaving early." };
  }

  let insideFence: boolean | null = null;
  if (record.zone_id) {
    const { data: zone } = await supabase.from("duty_zones").select("*").eq("id", record.zone_id).maybeSingle();
    if (zone) insideFence = pointInPolygon(input.lng, input.lat, (zone as DutyZone).polygon);
  }

  const { error } = await supabase
    .from("duty_records")
    .update({
      check_out_at: now.toISOString(),
      check_out_lat: input.lat,
      check_out_lng: input.lng,
      check_out_inside_fence: insideFence,
      early_out_minutes: earlyMinutes,
      early_out_remark: earlyMinutes > 0 ? input.early_out_remark.trim() : null,
    })
    .eq("id", record.id)
    .eq("profile_id", profile.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/duty");
  revalidatePath("/home");
  return { ok: true, id: record.id };
}
