"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { REQUESTABLE_ROLES, type UserRole } from "@/lib/reference-data";

export async function updateProfile(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") || "").trim();
  const staff_no = String(formData.get("staff_no") || "").trim();
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const role = String(formData.get("role") || "").trim() as UserRole;

  if (!name || !staff_no || !station || !team || !role) {
    redirect("/profile-setup?error=missing");
  }
  if (!REQUESTABLE_ROLES.includes(role as (typeof REQUESTABLE_ROLES)[number])) {
    redirect("/profile-setup?error=Invalid role");
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ name, staff_no, station, team, role })
    .eq("id", user!.id);

  if (error) {
    redirect(`/profile-setup?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/");
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
