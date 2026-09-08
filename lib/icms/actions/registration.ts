"use server";

import { createClient } from "@/lib/supabase/server";

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
    const supabase = await createClient();

    const { data: created, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          full_name: name,
          staff_id: staffId,
          role: "vendor",
          unified_role: "vendor",
        },
      },
    });

    if (authError || !created.user) {
      return { error: authError?.message ?? "Could not create account.", success: null };
    }

    // Insert driver record into public.users table
    const { error: profileError } = await supabase.from("users").upsert(
      {
        id: created.user.id,
        name,
        staff_id: staffId,
        email,
        role: "vendor",
        unified_role: "vendor",
        status: "active",
      },
      { onConflict: "id" }
    );

    if (profileError) {
      console.error("[registerDriver] note on users row insert:", profileError.message);
    }

    return {
      error: null,
      success: "Registration successful! You can now sign in with your email and password.",
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to register driver account",
      success: null,
    };
  }
}
