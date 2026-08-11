"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { REQUESTABLE_ROLES, ORG_WIDE_ROLES, type UserRole } from "@/lib/reference-data";

export async function approveUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = createClient();
  await supabase.from("profiles").update({ status: "approved" }).eq("id", profileId);
  revalidatePath("/admin/users");
}

export async function rejectUser(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  if (!profileId) return;

  const supabase = createClient();
  await supabase.from("profiles").update({ status: "rejected" }).eq("id", profileId);
  revalidatePath("/admin/users");
}

// Lets Admin reassign someone's station/team mid-month (e.g. Kamal moves from Bravo to
// Alpha) or correct their role — including promoting to ADMIN, which users can never
// self-select.
export async function updateUserAssignment(formData: FormData) {
  await requireRole(ADMIN_ROLES);
  const profileId = String(formData.get("profileId") || "");
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const role = String(formData.get("role") || "").trim() as UserRole;
  if (!profileId || !station || !role) return;

  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "ADMIN"];
  if (!allRoles.includes(role)) return;
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);

  const supabase = createClient();
  await supabase
    .from("profiles")
    .update({ station, team: isOrgWide ? "" : team, role })
    .eq("id", profileId);
  revalidatePath("/admin/users");
}
