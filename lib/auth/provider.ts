import "server-only";

import type { AuthProvider } from "./types";
import { supabaseAuthProvider } from "./providers/supabase";
import { firebaseAuthProvider } from "./providers/firebase";

export type AuthProviderName = "supabase" | "firebase";

/** AUTH_PROVIDER env var selects the active adapter. Defaults to supabase. */
export function getAuthProviderName(): AuthProviderName {
  return process.env.AUTH_PROVIDER === "firebase" ? "firebase" : "supabase";
}

/** Resolves the active AuthProvider. Every call site should go through this
 *  rather than importing a provider adapter directly. */
export function getAuthProvider(): AuthProvider {
  return getAuthProviderName() === "firebase" ? firebaseAuthProvider : supabaseAuthProvider;
}
