"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";

function backTo(station: string, week: string) {
  return `/avsec/admin/roster?station=${encodeURIComponent(station)}&week=${week}`;
}

/**
 * Roster authority is canonical (Phase 8): operation_manager (any station),
 * hub_se (stations of the assigned hub), dse (own station AND team). The
 * database RPCs enforce it; nothing here reads ops_group, and the historical
 * team_rosters.ops_group column is written only by the RPC as a fixed
 * compatibility value.
 */

export async function upsertRosterCell(formData: FormData) {
  await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const rosterDate = String(formData.get("roster_date") || "").trim();
  const shiftCode = String(formData.get("shift_code") || "").trim();
  const startTime = String(formData.get("start_time") || "").trim();
  const endTime = String(formData.get("end_time") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const week = String(formData.get("week") || "").trim();

  if (!station || !team || !rosterDate || !shiftCode) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("Missing required roster fields."));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("upsert_roster_cell_secure", {
    p_station: station,
    p_team: team,
    p_roster_date: rosterDate,
    p_shift_code: shiftCode,
    p_start_time: startTime || null,
    p_end_time: endTime || null,
    p_notes: notes || null,
  });

  if (error) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/avsec/admin/roster");
}

export async function clearRosterCell(formData: FormData) {
  await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const rosterDate = String(formData.get("roster_date") || "").trim();
  const week = String(formData.get("week") || "").trim();
  if (!station || !team || !rosterDate) return;

  const supabase = await createClient();
  const { error } = await supabase.rpc("clear_roster_cell_secure", { p_station: station, p_team: team, p_roster_date: rosterDate });
  if (error) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/avsec/admin/roster");
}

// Adds a new team column for a station — used from the empty-state prompt when a station
// has no teams defined yet, or to add an extra team later.
export async function addStationTeam(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const station = String(formData.get("station") || "").trim();
  // Teams are defined by the organisation structure (org_teams), seeded and
  // changed through the reviewed seeding tooling -- never created from a page.
  redirect(backTo(station, "") + "&error=" + encodeURIComponent("Teams come from the organisation structure and cannot be added here."));
}

const MAX_RANGE_DAYS = 31;

function isoDatesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (cursor <= end && dates.length <= MAX_RANGE_DAYS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// "Set Shift by Team" — applies one saved schedule to every date in a range for a whole
// team in one action, instead of clicking through an officer's cell per day. Writes the
// exact same team_rosters rows upsertRosterCell would, just for a whole date range at once.
export async function setTeamScheduleRange(formData: FormData) {
  await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const shiftCode = String(formData.get("shift_code") || "").trim();
  const dateFrom = String(formData.get("date_from") || "").trim();
  const dateTo = String(formData.get("date_to") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const week = String(formData.get("week") || "").trim();

  if (!station || !team || !shiftCode || !dateFrom || !dateTo) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("Pick a team, a schedule, and a date range."));
  }
  if (dateTo < dateFrom) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("End date must be on or after the start date."));
  }

  const dates = isoDatesBetween(dateFrom, dateTo);
  if (dates.length > MAX_RANGE_DAYS) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(`Pick ${MAX_RANGE_DAYS} days or fewer at a time.`));
  }

  const supabase = await createClient();
  const { data: shift } = await supabase
    .from("shifts")
    .select("default_start, default_end")
    .eq("code", shiftCode)
    .maybeSingle();

  for (const date of dates) {
    const { error } = await supabase.rpc("upsert_roster_cell_secure", {
      p_station: station,
      p_team: team,
      p_roster_date: date,
      p_shift_code: shiftCode,
      p_start_time: shift?.default_start ?? null,
      p_end_time: shift?.default_end ?? null,
      p_notes: notes || null,
    });
    if (error) {
      redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
    }
  }

  revalidatePath("/avsec/admin/roster");
}

// "Create Schedule" — a named, reusable schedule preset (custom label + timing, or an
// off-day preset with no timing). Saved presets show up in every roster cell's shift
// picker immediately, since that dropdown is just `shifts` rendered in display order.
export async function createShift(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const label = String(formData.get("label") || "").trim();
  const isOff = formData.get("is_off") === "on";
  const startTime = isOff ? "" : String(formData.get("start_time") || "").trim();
  const endTime = isOff ? "" : String(formData.get("end_time") || "").trim();
  const colorHex = String(formData.get("color_hex") || "").trim() || "#6f6a58";

  if (!label) {
    redirect("/avsec/admin/roster?error=" + encodeURIComponent("Schedule name is required."));
  }
  if (!isOff && (!startTime || !endTime)) {
    redirect("/avsec/admin/roster?error=" + encodeURIComponent("Start and end time are required unless this is an off-day schedule."));
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("shifts")
    .select("display_order")
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const code = `S${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

  const { error } = await supabase.from("shifts").insert({
    code,
    label,
    default_start: isOff ? null : startTime,
    default_end: isOff ? null : endTime,
    color_hex: colorHex,
    display_order: (existing?.display_order ?? 0) + 1,
  });

  if (error) {
    redirect("/avsec/admin/roster?error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/avsec/admin/roster");
}

// "OFF" is hardcoded as a sentinel string across the duty module (check-in screen, roster
// cell, timesheet, overtime, monitor queries) — deleting that specific row would silently
// break the "Off day" option everywhere else, so it's the one preset that can't be removed
// from here. Everything else (including the seeded Morning/Afternoon/Night) can be.
const PROTECTED_SHIFT_CODE = "OFF";

export async function deleteShift(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const code = String(formData.get("code") || "").trim();
  if (!code || code === PROTECTED_SHIFT_CODE) return;

  const supabase = await createClient();
  const { error } = await supabase.from("shifts").delete().eq("code", code);

  if (error) {
    const message = error.message.toLowerCase().includes("foreign key")
      ? "This schedule is still assigned in the roster — clear those cells first, then delete it."
      : error.message;
    redirect("/avsec/admin/roster?error=" + encodeURIComponent(message));
  }

  revalidatePath("/avsec/admin/roster");
}
