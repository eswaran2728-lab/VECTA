"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/avsec/supabase/server";
import { getCurrentUser } from "@/lib/avsec/auth";
import { REQUESTABLE_ROLES, ORG_WIDE_ROLES, type UserRole } from "@/lib/avsec/reference-data";

export async function updateProfile(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") || "").trim();
  const staff_no = String(formData.get("staff_no") || "").trim();
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const role = String(formData.get("role") || "").trim() as UserRole;

  if (!REQUESTABLE_ROLES.includes(role as (typeof REQUESTABLE_ROLES)[number])) {
    redirect("/avsec/profile-setup?error=Invalid role");
  }
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(role);

  if (!name || !station || !role || (!isOrgWide && (!staff_no || !team))) {
    redirect("/avsec/profile-setup?error=missing");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ name, staff_no, station, team, role })
    .eq("id", user!.id);

  if (error) {
    redirect(`/avsec/profile-setup?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
