"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { signInWithGoogle } from "@/lib/auth/providers/firebase-client";

/**
 * Google sign-in is inherently a browser operation (signInWithPopup) — it
 * cannot be a Server Action the way Supabase's email/password sign-in is.
 * The flow: sign in with Firebase's client SDK, hand the resulting ID
 * token to the server twice (establish a session cookie, then sync
 * claims), then force a token refresh before navigating so the browser's
 * next request actually carries the fresh custom claims — see
 * /api/auth/sync-claims's header comment for why that last step matters.
 */
export function GoogleSignInButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      const user = await signInWithGoogle();
      const idToken = await user.getIdToken();

      const sessionRes = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!sessionRes.ok) {
        const body = await sessionRes.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? "Could not establish session.");
      }

      const syncRes = await fetch("/api/auth/sync-claims", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!syncRes.ok) {
        const body = await syncRes.json().catch(() => ({}) as { error?: string });
        throw new Error(body.error ?? "Could not sync your account.");
      }

      await user.getIdToken(true);

      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="vecta-btn-primary flex items-center justify-center gap-2"
      >
        {pending ? "Signing in…" : "Sign in with Google Workspace"}
      </button>
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-brand">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}
