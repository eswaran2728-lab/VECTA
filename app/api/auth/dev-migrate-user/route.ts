import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFirebaseAdminAuth } from "@/lib/auth/providers/firebase-admin";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY Phase 3 testing tool — delete before Phase 4's real cutover.
 *
 * Manually previews what Phase 4's migrate-users.ts will do at scale for
 * every existing account: delete/recreate a Firebase user with its uid
 * forced to equal the account's existing Supabase profiles/users.id
 * (a UUID string, well within Firebase's 128-char custom-uid limit), so
 * every id-based lookup in the app (RLS's auth.uid(), app/page.tsx's
 * profile query, etc.) resolves correctly once that account signs in via
 * Firebase — instead of Firebase auto-assigning its own unrelated id, as
 * happens on an organic first sign-in before this has run.
 *
 * Protected by a shared secret (not real admin auth — this route doesn't
 * exist once Phase 4 ships) passed as `?secret=`, checked against
 * DEV_MIGRATE_SECRET. Looks up the target id itself from
 * public.user_claims by email — never accepts a caller-supplied uid.
 *
 * Accepts GET (email as a query param) as well as POST (email in a JSON
 * body) — GET lets this be triggered with a plain browser navigation,
 * avoiding CORS entirely for one-off manual use.
 */
async function migrate(request: NextRequest, email: string | undefined) {
  const secret = request.nextUrl.searchParams.get("secret");
  const expected = process.env.DEV_MIGRATE_SECRET;
  if (!expected || !secret || secret !== expected) {
    // Disposable debug tool, deleted before Phase 4 — lengths only, never
    // the actual values, to unblock a stuck env-var mismatch without
    // exposing either secret in the response.
    return NextResponse.json(
      {
        error: "Not authorized.",
        debug: {
          receivedSecretLength: secret?.length ?? 0,
          expectedIsSet: Boolean(expected),
          expectedLength: expected?.length ?? 0,
        },
      },
      { status: 401 }
    );
  }

  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return NextResponse.json({ error: "Missing email." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("user_claims" as never)
    .select("id")
    .ilike("email", normalizedEmail)
    .maybeSingle();
  const row = data as { id: string } | null;
  if (!row) {
    return NextResponse.json({ error: "No VECTA account for that email." }, { status: 404 });
  }

  const auth = getFirebaseAdminAuth();

  // Capture the real Google federated identity (providerData) off any
  // existing account for this email BEFORE deleting it. A plain
  // auth.createUser({uid, email}) has no linked Google credential, so a
  // later real Google sign-in doesn't recognize it as the same account —
  // it silently creates a brand-new, separately-uid'd Firebase user
  // instead (confirmed via debug-profile: the JWT sub after signing in
  // was a fresh auto-generated id, not the forced uid). Re-importing with
  // that same providerData is what makes a future Google sign-in resolve
  // back to OUR forced (UUID-shaped) uid instead of minting another one.
  let googleProvider: { providerId: string; uid: string; email?: string; displayName?: string; photoURL?: string } | undefined;
  try {
    const existing = await auth.getUserByEmail(normalizedEmail);
    googleProvider = existing.providerData.find((p) => p.providerId === "google.com") as
      | { providerId: string; uid: string; email?: string; displayName?: string; photoURL?: string }
      | undefined;
    await auth.deleteUser(existing.uid);
  } catch {
    // No existing Firebase user for this email — nothing to delete/capture.
  }

  if (googleProvider) {
    const importResult = await auth.importUsers([
      {
        uid: row.id,
        email: normalizedEmail,
        emailVerified: true,
        providerData: [
          {
            providerId: "google.com",
            uid: googleProvider.uid,
            email: googleProvider.email ?? normalizedEmail,
            displayName: googleProvider.displayName,
            photoURL: googleProvider.photoURL,
          },
        ],
      },
    ]);
    if (importResult.failureCount > 0) {
      return NextResponse.json(
        { error: "importUsers failed.", details: importResult.errors },
        { status: 500 }
      );
    }
    return NextResponse.json({
      uid: row.id,
      matchesSupabaseId: true,
      linkedGoogleIdentity: true,
    });
  }

  // No prior Google sign-in captured yet — fall back to a bare account
  // (same as before). The FIRST Google sign-in after this will still mint
  // its own separate uid; re-run this route once more afterwards to link
  // it properly, or just sign in first, then run this.
  const created = await auth.createUser({
    uid: row.id,
    email: normalizedEmail,
    emailVerified: true,
  });

  return NextResponse.json({
    uid: created.uid,
    matchesSupabaseId: created.uid === row.id,
    linkedGoogleIdentity: false,
    note: "No prior Google sign-in found for this email — sign in once first, then re-run this route to link the real Google identity.",
  });
}

export async function GET(request: NextRequest) {
  return migrate(request, request.nextUrl.searchParams.get("email") ?? undefined);
}

export async function POST(request: NextRequest) {
  let body: { email?: string } = {};
  try {
    body = await request.json();
  } catch {
    // fall through with empty body -> "Missing email." below
  }
  return migrate(request, body.email);
}
