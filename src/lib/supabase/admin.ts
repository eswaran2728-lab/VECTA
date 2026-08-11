import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — bypasses RLS and can call the Auth admin API (create/delete users).
// Server-only: never import this from a Client Component or expose the key to the browser.
//
// Deliberately prefers the plain SUPABASE_URL over NEXT_PUBLIC_SUPABASE_URL: Next.js inlines
// NEXT_PUBLIC_ vars into the compiled bundle at build time per route, and Server Actions are
// bundled separately from page renders — in practice that inlining doesn't reliably reach this
// file even though the same var works fine in Server Components. A non-NEXT_PUBLIC_ var is read
// live from process.env at request time instead, sidestepping the inlining entirely.
export function createAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return createSupabaseClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
