"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";

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
