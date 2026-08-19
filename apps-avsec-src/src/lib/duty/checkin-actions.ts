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

// Below this, it's not worth a claim — matches the "even 30 minutes counts" rule without
// generating noise for a two-minute overrun.
const OT_THRESHOLD_MINUTES = 30;

function driftError(clientTimestamp: string): string | null {
  const drift = Math.abs(Date.now() - new Date(clientTimestamp).getTime());
  if (Number.isNaN(drift) || drift > MAX_CLIENT_DRIFT_MS) {
    return "This check-in is too old to submit (captured over 30 minutes ago) — please try again with a fresh location fix.";
  }
  return null;
}

// Every team checks in/out at any of the station's marked zones — not one zone assigned
// per shift. Returns the first zone the point falls inside, or null if it's outside all
// of them (or the station has none defined, in which case there's nothing to enforce).
async function matchStationZone(
  supabase: ReturnType<typeof createClient>,
  station: string,
  lng: number,
  lat: number,
): Promise<{ zones: DutyZone[]; match: DutyZone | null }> {
  const { data } = await supabase.from("duty_zones").select("*").eq("station", station).eq("active", true);
  const zones = (data ?? []) as DutyZone[];
  const match = zones.find((z) => pointInPolygon(lng, lat, z.polygon)) ?? null;
  return { zones, match };
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
    .select("shift_code, start_time, end_time")
    .eq("station", profile.station)
    .eq("team", profile.team ?? "")
    .eq("roster_date", dutyDate)
    .maybeSingle();

  if (!roster) return { ok: false, error: "No roster set for today — contact your supervisor." };

  // Both check-in and check-out must happen inside one of the station's marked zones.
  // No zones defined at all means nothing to enforce.
  const { zones, match } = await matchStationZone(supabase, profile.station, values.lng, values.lat);
  const insideFence = zones.length === 0 ? null : !!match;

  if (insideFence === false) {
    return {
      ok: false,
      error: "You must be within a marked duty zone to check in — move to one of the zones and try again.",
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
      zone_id: match?.id ?? null,
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

  // Find whichever shift is currently open — never assume it started "today". A Night
  // shift checked in at 23:00 on day 1 checks out after 07:00 on day 2, past midnight —
  // by then "today" has already flipped, but the shift still belongs to day 1's roster.
  const { data: record } = await supabase
    .from("duty_records")
    .select("id, duty_date, check_in_at")
    .eq("profile_id", profile.id)
    .is("check_out_at", null)
    .not("check_in_at", "is", null)
    .order("check_in_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) return { ok: false, error: "No open check-in found." };

  const dutyDate = record.duty_date;

  // Checking out must happen inside one of the station's marked zones too — not
  // necessarily the same one checked in at, since staff patrol/move during the shift.
  const { zones, match } = await matchStationZone(supabase, profile.station, values.lng, values.lat);
  const insideFence = zones.length === 0 ? null : !!match;

  if (insideFence === false) {
    return {
      ok: false,
      error: "You must be within a marked duty zone to check out — move to one of the zones and try again.",
    };
  }

  const { data: roster } = await supabase
    .from("team_rosters")
    .select("shift_code, start_time, end_time")
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

  // Auto-detect overtime from actual worked time vs the roster's scheduled shift — never
  // something the officer has to remember to file. 30+ minutes past the scheduled end (or,
  // with no scheduled shift at all, the entire duration) becomes a pending OT request DSE
  // can endorse and Management/Admin approve, linked straight back to this duty record.
  // Best-effort: the checkout above has already succeeded, so a failure here must never
  // surface as a checkout error.
  try {
    if (record.check_in_at) {
      const checkInAt = new Date(record.check_in_at);
      const hasScheduledShift = !!(roster?.start_time && roster?.end_time && roster.shift_code !== "OFF");
      const scheduledEnd = hasScheduledShift
        ? scheduledWindow(dutyDate, roster!.start_time!, roster!.end_time!).end
        : checkInAt;
      const overageMinutes = Math.round((now.getTime() - scheduledEnd.getTime()) / 60000);

      if (overageMinutes >= OT_THRESHOLD_MINUTES) {
        const { data: existingOt } = await supabase
          .from("overtime_requests")
          .select("id")
          .eq("linked_duty_id", record.id)
          .maybeSingle();

        if (!existingOt) {
          const overageHours = (overageMinutes / 60).toFixed(1);
          await supabase.from("overtime_requests").insert({
            profile_id: profile.id,
            station: profile.station,
            team: profile.team || null,
            work_date: dutyDate,
            shift_code: roster?.shift_code ?? null,
            start_at: scheduledEnd.toISOString(),
            end_at: now.toISOString(),
            category: hasScheduledShift ? "adhoc" : "off_day_work",
            reason: `Auto-recorded from check-out — worked ${overageHours}h beyond the scheduled shift.`,
            linked_duty_id: record.id,
          });
          revalidatePath("/duty/overtime");
        }
      }
    }
  } catch {
    // Swallowed — the checkout itself already succeeded above.
  }

  revalidatePath("/duty");
  revalidatePath("/home");
  return { ok: true, id: record.id };
}
