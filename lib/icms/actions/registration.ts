"use server";

import { createAdminClient } from "@/lib/supabase/admin";

export interface RegisterState {
  error: string | null;
  success: string | null;
}

export async function registerDriver(_prev: RegisterState, formData: FormData): Promise<RegisterState> {
  const name = String(formData.get("name") ?? "").trim();
  const staffId = String(formData.get("staff_id") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!name || !staffId || !email) {
    return { error: "Name, Driver ID / NRIC, and email are required.", success: null };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters.", success: null };
  }

  try {
    const admin = createAdminClient();

    const { data: created, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError || !created.user) {
      return { error: authError?.message ?? "Could not create account.", success: null };
    }

    const { error: profileError } = await admin.from("users").insert({
      id: created.user.id,
      name,
      staff_id: staffId,
      email,
      role: "vendor",
      unified_role: "vendor",
      status: "active", // active so driver can start immediately
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return { error: `Registration error: ${profileError.message}`, success: null };
    }

    return {
      error: null,
      success: "Registration successful! You can now sign in with your credentials.",
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to register driver account",
      success: null,
    };
  }
}
