"use client";

import { createBrowserClient } from "@supabase/ssr";

// Not parameterized with generated Database types yet (see database.types.ts) — using
// `supabase gen types typescript` once the project is linked will re-enable full typing.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
