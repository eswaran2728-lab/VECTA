"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./env";

// Not parameterized with generated Database types yet (see database.types.ts) — using
// `supabase gen types typescript` once the project is linked will re-enable full typing.
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
