"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/avsec/auth";

export interface AnnouncementActionResult {
  ok: boolean;
  announcementId?: string;
  error?: string;
}

/**
 * Create a new management announcement targeted by branch, station, and team.
 */
export async function createAnnouncement({
  title,
  body,
  branch,
  station,
  team,
}: {
  title: string;
  body: string;
  branch?: "operation_avsec" | "ifc_avsec" | "hub_avsec" | null;
  station?: string | null;
  team?: string | null;
}): Promise<AnnouncementActionResult> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  if (profile.role !== "MANAGEMENT" && profile.role !== "ADMIN") {
    return { ok: false, error: "Only Management can post announcements." };
  }

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) {
    return { ok: false, error: "Title and body are required." };
  }

  const supabase = await createClient();

  // 1. Insert announcement
  const { data: announcement, error: annError } = await supabase
    .from("announcements")
    .insert({
      created_by: profile.id,
      title: trimmedTitle,
      body: trimmedBody,
    })
    .select("id")
    .single();

  if (annError || !announcement) {
    return { ok: false, error: annError?.message || "Failed to create announcement" };
  }

  // 2. Insert target row
  const targetBranch = branch || null;
  const targetStation = station?.trim() || null;
  const targetTeam = team?.trim() || null;

  const { error: targetError } = await supabase
    .from("announcement_targets")
    .insert({
      announcement_id: announcement.id,
      branch: targetBranch,
      station: targetStation,
      team: targetTeam,
    });

  if (targetError) {
    return { ok: false, error: targetError.message };
  }

  // 3. Send notifications to targeted staff in the organization
  let staffQuery = supabase.from("profiles").select("id, ops_group, station, team");
  if (targetBranch) staffQuery = staffQuery.eq("ops_group", targetBranch);
  if (targetStation) staffQuery = staffQuery.eq("station", targetStation);
  if (targetTeam) staffQuery = staffQuery.eq("team", targetTeam);

  const { data: targetStaff } = await staffQuery;
  if (targetStaff && targetStaff.length > 0) {
    const notifs = targetStaff.map((s) => ({
      user_id: s.id,
      title: `📢 Announcement: ${trimmedTitle}`,
      body: trimmedBody.slice(0, 120),
      is_read: false,
    }));
    await supabase.from("notifications").insert(notifs);
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true, announcementId: announcement.id };
}

/**
 * Record a user's acknowledgement of an announcement.
 */
export async function acknowledgeAnnouncement(
  announcementId: string
): Promise<{ ok: boolean; error?: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = await createClient();

  const { error } = await supabase
    .from("announcement_acknowledgements")
    .insert({
      announcement_id: announcementId,
      user_id: profile.id,
    });

  if (error) {
    // If unique constraint already exists, treat as already acknowledged
    if (error.code === "23505") {
      return { ok: true };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/avsec/home");
  revalidatePath("/avsec/dashboard");
  revalidatePath("/avsec/management/announcements");

  return { ok: true };
}
