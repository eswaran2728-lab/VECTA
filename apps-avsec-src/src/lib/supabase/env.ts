// Falls back to the AVSEC OPS Supabase project's public URL/anon key when the
// NEXT_PUBLIC_SUPABASE_* env vars aren't configured on the hosting platform.
// Both values are meant to be public (the anon key is protected by RLS), so this is safe —
// it just means the app works out of the box even before someone sets the real env vars.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://ddlctzbnqewubltcavkh.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_YW_wpjU07SgKs32CfwlJ7g_hQZKiiLh";
