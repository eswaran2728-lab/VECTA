"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";

export async function updateProfile(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const name = String(formData.get("name") || "").trim();
  const staff_no = String(formData.get("staff_no") || "").trim();
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();

  if (!name || !staff_no || !station || !team) {
    redirect("/profile-setup?error=missing");
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ name, staff_no, station, team })
    .eq("id", user!.id);

  if (error) {
    redirect(`/profile-setup?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/home");
}

export async function signOut() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
