"use client";

import { createBrowserClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getFirebaseClientAuth } from "@/lib/auth/providers/firebase-client";

/**
 * Browser-side counterpart to lib/supabase/server.ts — same
 * AUTH_PROVIDER branch, same reasoning. Server env vars aren't available
 * in client bundles, so this reads NEXT_PUBLIC_AUTH_PROVIDER (kept equal
 * to the server-only AUTH_PROVIDER — see .env.example).
 */
export function createClient() {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "firebase") {
    return createSupabaseJsClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        accessToken: async () => (await getFirebaseClientAuth().currentUser?.getIdToken()) ?? "",
      }
    );
  }

  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
