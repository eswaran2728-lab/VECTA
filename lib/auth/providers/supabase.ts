import "server-only";

import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import type { AuthProvider, AuthSession, AuthUser, SignInResult } from "../types";

function toAuthUser(user: { id: string; email?: string | null } | null): AuthUser | null {
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

export const supabaseAuthProvider: AuthProvider = {
  async signIn(email, password): Promise<SignInResult> {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      return { user: null, error: error?.message ?? "Invalid email or password." };
    }
    return { user: toAuthUser(data.user), error: null };
  },

  async signOut(): Promise<void> {
    const supabase = await createClient();
    await supabase.auth.signOut();
  },

  async getSession(): Promise<AuthSession | null> {
    const supabase = await createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user) return null;
    return { user: toAuthUser(session.user)!, accessToken: session.access_token };
  },

  async getUser(): Promise<AuthUser | null> {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return toAuthUser(user);
  },

  async getAccessToken(): Promise<string | null> {
    const session = await this.getSession();
    return session?.accessToken ?? null;
  },

  onAuthStateChange(): () => void {
    // Server-side only adapter — no live subscription here. Client
    // components that need this (none currently do) should use
    // lib/supabase/client.ts's browser client directly until a
    // client-side provider surface is needed.
    return () => {};
  },

  async refresh(): Promise<AuthSession | null> {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session?.user) return null;
    return { user: toAuthUser(data.session.user)!, accessToken: data.session.access_token };
  },
};

/**
 * Edge-middleware session resolution. Kept here (not in middleware.ts)
 * so the Supabase SDK's auth surface is imported only from this adapter
 * folder — the CI boundary check (scripts/check-auth-boundary.sh) enforces
 * that. middleware.ts calls this, then applies its own app-specific
 * redirect/gate logic using the returned user and response.
 *
 * Identical to the previous inline implementation in
 * lib/supabase/middleware.ts: do not add logic between createServerClient
 * and getUser() — it can cause session refresh race conditions.
 */
export async function resolveMiddlewareUser(
  request: NextRequest
): Promise<{
  user: AuthUser | null;
  response: NextResponse;
  client: ReturnType<typeof createServerClient<Database>>;
}> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return { user: toAuthUser(user), response, client: supabase };
  } catch {
    // Stale/invalid refresh token cookie: treat as signed out.
    return { user: null, response, client: supabase };
  }
}

/**
 * Bearer-token auth for server-to-server calls (CaterLink -> VECTA's
 * /api/icms/qr/mint), where cookie-based auth doesn't apply since the
 * caller is a different origin/app on the same Supabase project. Returns
 * both the resolved user and a Supabase client scoped to that bearer's
 * session, since the route also needs to run RLS-scoped table queries
 * with it — not just resolve identity.
 */
export async function getBearerAuth(
  bearer: string
): Promise<{ user: AuthUser | null; client: ReturnType<typeof createSupabaseJsClient<Database>> }> {
  const client = createSupabaseJsClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${bearer}` } } }
  );

  const {
    data: { user },
  } = await client.auth.getUser(bearer);

  return { user: toAuthUser(user), client };
}
