// AVSEC's typed view of the SAME shared Supabase client (same project, same URL/anon key)
// that @/lib/supabase/client.ts creates for ICMS — see lib/avsec/database.types.ts for why
// a separate type parameter is needed. Not a second Supabase project or session.
"use client";

import { createBrowserClient } from "@supabase/ssr";

// Deliberately untyped (no Database generic): ICMS's generated schema doesn't
// know AVSEC's tables, and a hand-rolled index-signature schema doesn't infer
// cleanly against the installed postgrest-js version. Same project/URL/anon
// key/session as @/lib/supabase/client.ts — only the TS view differs.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
