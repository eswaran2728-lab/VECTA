"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AuthState {
  error: string | null;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    return { error: "Invalid email or password." };
  }

  // Look up user role across both AVSEC profiles and ICMS users
  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase
      .from("profiles")
      .select("unified_role, role, status")
      .eq("id", data.user.id)
      .maybeSingle(),
    supabase
      .from("users")
      .select("unified_role, role, status")
      .eq("id", data.user.id)
      .maybeSingle(),
  ]);

  const profile = avsecProfile ?? icmsProfile;

  if (profile?.status === "pending" || profile?.status === "rejected") {
    await supabase.auth.signOut();
    redirect(`/login?error=${profile.status}`);
  }

  revalidatePath("/", "layout");

  // Single Login Page Router:
  // Check if account is a Driver / Vendor / Warehouse PIC account
  const rawRole = (icmsProfile?.role ?? avsecProfile?.role) as string | null;
  const isDriverOrVendor =
    profile?.unified_role === "vendor" ||
    rawRole === "vendor" ||
    rawRole === "driver_ifc" ||
    rawRole === "driver_vendor" ||
    rawRole === "warehouse_pic" ||
    email.endsWith("@caterlink.internal") ||
    email.includes("driver") ||
    email.includes("warehouse");

  if (isDriverOrVendor && !avsecProfile) {
    redirect("/icms/transactions");
  }

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
