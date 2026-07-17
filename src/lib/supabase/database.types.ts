// Minimal hand-written typing surface for the Supabase client.
// Generate the full types with `supabase gen types typescript` once the project is linked
// (see package.json script suggestion in README) — this file keeps the app compiling until then.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      [key: string]: {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
      };
    };
  };
}
