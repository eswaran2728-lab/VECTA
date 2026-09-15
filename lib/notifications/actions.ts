"use server";

import { createClient } from "@/lib/supabase/server";

/** Mark all of the current user's notifications as read. RLS scopes this to their own rows regardless of the eq() filter. */
export async function markNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id);
}
