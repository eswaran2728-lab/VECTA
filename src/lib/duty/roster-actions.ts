"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";

function backTo(station: string, week: string) {
  return `/admin/roster?station=${encodeURIComponent(station)}&week=${week}`;
}

export async function upsertRosterCell(formData: FormData) {
  const admin = await requireRole(ADMIN_ROLES);

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

  const supabase = createClient();
  const { error } = await supabase.from("team_rosters").upsert(
    {
      station,
      team,
      roster_date: rosterDate,
      shift_code: shiftCode,
      start_time: startTime || null,
      end_time: endTime || null,
      notes: notes || null,
      set_by: admin.id,
    },
    { onConflict: "station,team,roster_date" },
  );

  if (error) {
    redirect(backTo(station, week) + "&error=" + encodeURIComponent(error.message));
  }

  revalidatePath("/admin/roster");
}

export async function clearRosterCell(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const rosterDate = String(formData.get("roster_date") || "").trim();
  if (!station || !team || !rosterDate) return;

  const supabase = createClient();
  await supabase
    .from("team_rosters")
    .delete()
    .eq("station", station)
    .eq("team", team)
    .eq("roster_date", rosterDate);

  revalidatePath("/admin/roster");
}

// Adds a new team column for a station — used from the empty-state prompt when a station
// has no teams defined yet, or to add an extra team later.
export async function addStationTeam(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim().toUpperCase();
  if (!station || !team) return;

  const supabase = createClient();
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

  revalidatePath("/admin/roster");
}
