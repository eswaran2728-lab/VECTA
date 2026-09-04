"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthProvider } from "@/lib/auth/provider";

export interface AuthState {
  error: string | null;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const { user, error } = await getAuthProvider().signIn(email, password);

  if (error || !user) {
    return { error: "Invalid email or password." };
  }

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("users")
    .select("status")
    .eq("id", user.id)
    .single();

  if (profile?.status === "pending" || profile?.status === "rejected") {
    await getAuthProvider().signOut();
    redirect(`/login?error=${profile.status}`);
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signOut(): Promise<void> {
  await getAuthProvider().signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
