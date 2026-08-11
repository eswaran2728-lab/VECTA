import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS and can call the Auth admin API (create/delete users).
// Server-only: never import this from a Client Component or expose the key to the browser.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
