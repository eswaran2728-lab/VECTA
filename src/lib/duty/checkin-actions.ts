"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { todayISODateMY } from "@/lib/datetime";
import { dutyCheckInSchema, dutyCheckOutSchema } from "@/lib/schemas/duty";
import { pointInPolygon } from "./geofence";
import { scheduledWindow, computeLateMinutes, computeEarlyMinutes } from "./lateness";
import type { DutyZone } from "./types";

export interface ActionResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// A queued item can sit offline for a while before it's replayed on reconnect — reject
// anything stale enough that the captured location/time no longer means much.
const MAX_CLIENT_DRIFT_MS = 30 * 60 * 1000;

// Defensive ceiling only — duty_records ties check-in and check-out to the same row
// (unlike a raw punch-clock event log), so a single shift can't legitimately span days.
const MAX_SHIFT_MINUTES = 20 * 60;

function driftError(clientTimestamp: string): string | null {
  const drift = Math.abs(Date.now() - new Date(clientTimestamp).getTime());
  if (Number.isNaN(drift) || drift > MAX_CLIENT_DRIFT_MS) {
    return "This check-in is too old to submit (captured over 30 minutes ago) — please try again with a fresh location fix.";
  }
  return null;
}

// Takes unknown input (not a typed interface) so it can be called both directly, online,
// and later replayed from the IndexedDB offline queue with a JSON round-tripped payload —
// same contract as the report submit actions (submitSec016 etc). Re-derives everything
// authoritative from the DB (roster, zone) rather than trusting client-supplied values —
// the client's fence/lateness verdict is UI feedback only.
export async function submitDutyCheckIn(input: unknown): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station) return { ok: false, error: "Not authenticated" };

  const parsed = dutyCheckInSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid check-in payload." };
  const values = parsed.data;

  const drift = driftError(values.client_timestamp);
  if (drift) return { ok: false, error: drift };

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

  // Both check-in and check-out must happen at the assigned zone's pin-point location.
  // No zone assigned means nothing to enforce, so that case falls through unblocked.
  let insideFence: boolean | null = null;
  let zoneName: string | null = null;
  if (roster.zone_id) {
    const { data: zone } = await supabase.from("duty_zones").select("*").eq("id", roster.zone_id).maybeSingle();
    if (zone) {
      const z = zone as DutyZone;
      insideFence = pointInPolygon(values.lng, values.lat, z.polygon);
      zoneName = z.name;
    }
  }

  if (insideFence === false) {
    return {
      ok: false,
      error: `You must be at ${zoneName ?? "the assigned zone"} to check in — move to the pin-point location and try again.`,
    };
  }

  let lateMinutes = 0;
  const now = new Date();
  if (roster.start_time && roster.end_time && roster.shift_code !== "OFF") {
    const { start } = scheduledWindow(dutyDate, roster.start_time, roster.end_time);
    lateMinutes = computeLateMinutes(start, now);
  }

  if (lateMinutes > 0 && !values.late_remark.trim()) {
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
      check_in_lat: values.lat,
      check_in_lng: values.lng,
      check_in_accuracy_m: values.accuracy_m,
      check_in_inside_fence: insideFence,
      check_in_offline: values.offline,
      status: lateMinutes > 0 ? "late" : "present",
      late_minutes: lateMinutes,
      late_remark: lateMinutes > 0 ? values.late_remark.trim() : null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/duty");
  revalidatePath("/home");
  return { ok: true, id: data.id };
}

export async function submitDutyCheckOut(input: unknown): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !profile.station) return { ok: false, error: "Not authenticated" };

  const parsed = dutyCheckOutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid check-out payload." };
  const values = parsed.data;

  const drift = driftError(values.client_timestamp);
  if (drift) return { ok: false, error: drift };

  const supabase = createClient();
  const dutyDate = todayISODateMY();

  const { data: record } = await supabase
    .from("duty_records")
    .select("id, zone_id, check_in_at")
    .eq("profile_id", profile.id)
    .eq("duty_date", dutyDate)
    .is("check_out_at", null)
    .not("check_in_at", "is", null)
    .order("check_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) return { ok: false, error: "No open check-in found for today." };

  // Staff patrol/move during the shift — check-in doesn't require a fixed spot — but
  // checking out closes the shift and must happen back at the assigned zone. No zone
  // assigned means nothing to enforce, so that case falls through unblocked.
  let insideFence: boolean | null = null;
  let zoneName: string | null = null;
  if (record.zone_id) {
    const { data: zone } = await supabase.from("duty_zones").select("*").eq("id", record.zone_id).maybeSingle();
    if (zone) {
      const z = zone as DutyZone;
      insideFence = pointInPolygon(values.lng, values.lat, z.polygon);
      zoneName = z.name;
    }
  }

  if (insideFence === false) {
    return {
      ok: false,
      error: `You must be at ${zoneName ?? "the assigned zone"} to check out — move to the pin-point location and try again.`,
    };
  }

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

  if (earlyMinutes > 0 && !values.early_out_remark.trim()) {
    return { ok: false, error: "A remark is required — you're leaving early." };
  }

  const totalMinutes = record.check_in_at
    ? Math.min(
        Math.max(Math.round((now.getTime() - new Date(record.check_in_at).getTime()) / 60000), 0),
        MAX_SHIFT_MINUTES,
      )
    : null;

  const { error } = await supabase
    .from("duty_records")
    .update({
      check_out_at: now.toISOString(),
      check_out_lat: values.lat,
      check_out_lng: values.lng,
      check_out_inside_fence: insideFence,
      early_out_minutes: earlyMinutes,
      early_out_remark: earlyMinutes > 0 ? values.early_out_remark.trim() : null,
      total_minutes: totalMinutes,
      is_missing_checkout: false,
    })
    .eq("id", record.id)
    .eq("profile_id", profile.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath("/duty");
  revalidatePath("/home");
  return { ok: true, id: record.id };
}
