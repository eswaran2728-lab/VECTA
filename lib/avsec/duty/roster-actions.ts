"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import type { OpsGroup } from "@/lib/avsec/reference-data";
import { OPS_GROUPS } from "@/lib/avsec/reference-data";

function backTo(station: string, week: string) {
  return `/avsec/admin/roster?station=${encodeURIComponent(station)}&week=${week}`;
}

/**
 * Roster branch isolation (2026-09-22/23 — see
 * supabase/migrations/20260922000005_team_rosters_ops_group.sql): every
 * roster row must carry an ops_group. A DSE writer's own stored ops_group
 * is used automatically (they can only ever roster their own branch); a
 * Management/Admin writer must explicitly choose one, since they're
 * org-wide and could otherwise silently mis-attribute a row.
 *
 * `ADMIN_ROLES` currently gates these actions to MANAGEMENT/ADMIN only —
 * there's no DSE-facing roster UI in the app yet, so the DSE branch below
 * is ready for that but not yet reachable from any page.
 */
function resolveRosterOpsGroup(
  writer: { role: string; ops_group?: string | null },
  requestedOpsGroup: string,
): { ok: true; opsGroup: OpsGroup } | { ok: false; error: string } {
  if (writer.role === "DSE") {
    if (!writer.ops_group || !(OPS_GROUPS as readonly string[]).includes(writer.ops_group)) {
      return { ok: false, error: "Your account has no ops group assigned — contact an admin." };
    }
    return { ok: true, opsGroup: writer.ops_group as OpsGroup };
  }
  if (!(OPS_GROUPS as readonly string[]).includes(requestedOpsGroup)) {
    return { ok: false, error: "Select which AVSEC group (Operation, IFC, or Hub) this roster is for." };
  }
  return { ok: true, opsGroup: requestedOpsGroup as OpsGroup };
}

export async function upsertRosterCell(formData: FormData) {
  const writer = await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const rosterDate = String(formData.get("roster_date") || "").trim();
  const shiftCode = String(formData.get("shift_code") || "").trim();
  const startTime = String(formData.get("start_time") || "").trim();
  const endTime = String(formData.get("end_time") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const week = String(formData.get("week") || "").trim();
  const requestedOpsGroup = String(formData.get("ops_group") || "").trim();

  if (!station || !team || !rosterDate || !shiftCode) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("Missing required roster fields."));
  }

  const opsGroupResult = resolveRosterOpsGroup(writer, requestedOpsGroup);
  if (!opsGroupResult.ok) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(opsGroupResult.error));
  }

  const supabase = await createClient();
  const { error } = await supabase.from("team_rosters").upsert(
    {
      station,
      team,
      roster_date: rosterDate,
      shift_code: shiftCode,
      start_time: startTime || null,
      end_time: endTime || null,
      notes: notes || null,
      set_by: writer.id,
      ops_group: opsGroupResult.opsGroup,
    },
    { onConflict: "station,team,roster_date,ops_group" },
  );

  if (error) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/avsec/admin/roster");
}

export async function clearRosterCell(formData: FormData) {
  const writer = await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const rosterDate = String(formData.get("roster_date") || "").trim();
  const opsGroup = String(formData.get("ops_group") || "").trim();
  if (!station || !team || !rosterDate) return;

  const supabase = await createClient();
  let query = supabase.from("team_rosters").delete().eq("station", station).eq("team", team).eq("roster_date", rosterDate);
  // Scope by ops_group whenever it's known, so clearing one branch's cell
  // can never remove the other branch's row for the same team-name/date.
  // DSE can only ever act within their own branch either way.
  if (writer.role === "DSE" && writer.ops_group) {
    query = query.eq("ops_group", writer.ops_group);
  } else if (opsGroup) {
    query = query.eq("ops_group", opsGroup);
  }
  await query;

  revalidatePath("/avsec/admin/roster");
}

// Adds a new team column for a station — used from the empty-state prompt when a station
// has no teams defined yet, or to add an extra team later.
export async function addStationTeam(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim().toUpperCase();
  if (!station || !team) return;

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("station_teams")
    .select("display_order")
    .eq("station", station)
    .order("display_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  await supabase.from("station_teams").upsert(
    {
      station,
      team,
      display_order: (existing?.display_order ?? 0) + 1,
      active: true,
    },
    { onConflict: "station,team" },
  );

  revalidatePath("/avsec/admin/roster");
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
  const writer = await requireRole([...ADMIN_ROLES, "DSE"]);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const shiftCode = String(formData.get("shift_code") || "").trim();
  const dateFrom = String(formData.get("date_from") || "").trim();
  const dateTo = String(formData.get("date_to") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const week = String(formData.get("week") || "").trim();
  const requestedOpsGroup = String(formData.get("ops_group") || "").trim();

  if (!station || !team || !shiftCode || !dateFrom || !dateTo) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("Pick a team, a schedule, and a date range."));
  }
  if (dateTo < dateFrom) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent("End date must be on or after the start date."));
  }

  const opsGroupResult = resolveRosterOpsGroup(writer, requestedOpsGroup);
  if (!opsGroupResult.ok) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(opsGroupResult.error));
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

  const rows = dates.map((date) => ({
    station,
    team,
    roster_date: date,
    shift_code: shiftCode,
    start_time: shift?.default_start ?? null,
    end_time: shift?.default_end ?? null,
    notes: notes || null,
    set_by: writer.id,
    ops_group: opsGroupResult.opsGroup,
  }));

  const { error } = await supabase.from("team_rosters").upsert(rows, { onConflict: "station,team,roster_date,ops_group" });

  if (error) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
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
