"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/icms/database.types";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
