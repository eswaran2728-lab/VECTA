import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/supabase/database.types";
import { ID_TOKEN_COOKIE } from "@/lib/auth/providers/firebase-cookies";

/**
 * Every server-side `.from()`/`.storage` call in the app goes through
 * this factory (unrelated to which AuthProvider is active for identity —
 * see lib/auth/provider.ts). When AUTH_PROVIDER=firebase, requests must
 * carry a Firebase ID token instead of a Supabase session cookie, per
 * Supabase's Third-Party Auth integration (see AUTH-CONTRACT.md and the
 * master migration plan's Phase 3, step 8) — the accessToken option below
 * is what makes auth.uid()/auth.jwt() resolve against a Firebase-issued
 * JWT inside RLS. Reads the fb-id-token cookie directly (not through
 * lib/auth/provider.ts) to avoid a circular import: providers/supabase.ts
 * already imports this file.
 */
export async function createClient() {
  const cookieStore = await cookies();

  if (process.env.AUTH_PROVIDER === "firebase") {
    return createSupabaseJsClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        accessToken: async () => cookieStore.get(ID_TOKEN_COOKIE)?.value ?? "",
      }
    );
  }

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component; middleware refreshes sessions.
          }
        },
      },
    }
  );
}
