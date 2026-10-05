"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isExternalCaterLinkRole } from "@/lib/supabase/middleware-gate-logic";
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

  // Account status across both AVSEC profiles and ICMS users. Roles are
  // never read here: operational access is canonical (Phase 3 assignments).
  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("status").eq("id", data.user.id).maybeSingle(),
    supabase.from("users").select("role, status").eq("id", data.user.id).maybeSingle(),
  ]);

  const profile = avsecProfile ?? icmsProfile;

  if (profile?.status === "pending" || profile?.status === "rejected") {
    await supabase.auth.signOut();
    redirect(`/login?error=${profile.status}`);
  }

  revalidatePath("/", "layout");

  // Single Login Page Router: external CaterLink identities are recognised
  // ONLY by the ICMS users-table role (never by email text or metadata),
  // and only when the account holds no canonical assignment.
  const { data: assignmentRows } = await supabase.rpc("get_my_active_role_assignments");
  const hasAssignment = Array.isArray(assignmentRows) && assignmentRows.length > 0;
  if (!hasAssignment && isExternalCaterLinkRole(icmsProfile?.role as string | undefined)) {
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
