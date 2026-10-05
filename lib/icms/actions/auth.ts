"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { classifyPortalAccess, isCaterLinkOnly } from "@/lib/auth/caterlink-access";
import { deriveCanonicalAccess, assignmentsFromRpcRows } from "@/lib/auth/canonical-access";
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

  // One portal decision from the trusted sources only (canonical assignments + the users-table account row).
  const { data: assignmentRows } = await supabase.rpc("get_my_active_role_assignments");
  const portal = classifyPortalAccess(deriveCanonicalAccess(assignmentsFromRpcRows(assignmentRows)), icmsProfile);
  if (portal.kind === "conflict" || portal.kind === "blocked") {
    await supabase.auth.signOut();
    redirect(`/login?error=${portal.kind === "conflict" ? "conflicting-access" : encodeURIComponent(portal.status ?? "pending")}`);
  }
  if (isCaterLinkOnly(portal.kind)) {
    revalidatePath("/", "layout");
    redirect("/caterlink/dashboard");
  }

  const profile = avsecProfile ?? icmsProfile;

  if (profile?.status === "pending" || profile?.status === "rejected") {
    await supabase.auth.signOut();
    redirect(`/login?error=${profile.status}`);
  }

  revalidatePath("/", "layout");

  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
