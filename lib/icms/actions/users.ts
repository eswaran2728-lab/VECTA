"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Role } from "@/lib/icms/database.types";
import { ALL_ROLES } from "@/lib/icms/constants";

export interface UserActionState {
  error: string | null;
  success: string | null;
}

/** Admin creates a new staff account (auth user + ICMS profile). */
export async function createUser(
  _prev: UserActionState,
  formData: FormData
): Promise<UserActionState> {
  await requireRole(["supervisor"]);

  const name = String(formData.get("name") ?? "").trim();
  const staffId = String(formData.get("staff_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as Role;
  const password = String(formData.get("password") ?? "");

  if (!name || !staffId || !email) {
    return { error: "Name, staff ID and email are required.", success: null };
  }
  if (!ALL_ROLES.includes(role)) {
    return { error: "Select a valid role.", success: null };
  }
  if (password.length < 10) {
    return { error: "Password must be at least 10 characters.", success: null };
  }

  const admin = createAdminClient();

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError || !created.user) {
    return { error: authError?.message ?? "Could not create auth account.", success: null };
  }

  const { error: profileError } = await admin.from("users").insert({
    id: created.user.id,
    name,
    staff_id: staffId,
    email,
    role,
  });

  if (profileError) {
    // Roll back the orphaned auth account so email can be retried.
    await admin.auth.admin.deleteUser(created.user.id);
    return { error: `Profile could not be saved: ${profileError.message}`, success: null };
  }

  revalidatePath("/icms/admin/users");
  return { error: null, success: `Account created for ${name} (${email}).` };
}

/** Admin changes an existing user's role. */
export async function updateUserRole(
  _prev: UserActionState,
  formData: FormData
): Promise<UserActionState> {
  const profile = await requireRole(["supervisor"]);

  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "") as Role;

  if (!userId || !ALL_ROLES.includes(role)) {
    return { error: "Invalid role update request.", success: null };
  }
  if (userId === profile.id) {
    return { error: "You cannot change your own role.", success: null };
  }

  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ role }).eq("id", userId);

  if (error) {
    return { error: error.message, success: null };
  }

  revalidatePath("/icms/admin/users");
  return { error: null, success: "Role updated." };
}
