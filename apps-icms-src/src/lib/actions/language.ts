"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isLang, type Lang } from "@/lib/i18n";

/** Read the current language: cookie first, then the user profile, then EN. */
export async function getLang(): Promise<Lang> {
  const store = await cookies();
  const fromCookie = store.get("cscs-lang")?.value;
  if (isLang(fromCookie)) return fromCookie;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const { data } = await supabase
      .from("users")
      .select("preferred_language")
      .eq("id", user.id)
      .single();
    const fromProfile = (data as { preferred_language?: string } | null)?.preferred_language;
    if (isLang(fromProfile)) return fromProfile;
  }
  return "en";
}

/** Toggle EN <-> BM; persisted per user (profile) and per device (cookie). */
export async function toggleLanguage(): Promise<void> {
  const current = await getLang();
  const next: Lang = current === "en" ? "ms" : "en";

  const store = await cookies();
  store.set("cscs-lang", next, { maxAge: 60 * 60 * 24 * 365, path: "/" });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    await supabase.from("users").update({ preferred_language: next }).eq("id", user.id);
  }
  revalidatePath("/", "layout");
}
