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
 */
export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  const expected = process.env.DEV_MIGRATE_SECRET;
  if (!expected || !secret || secret !== expected) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Missing email." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data } = await supabase
    .from("user_claims" as never)
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  const row = data as { id: string } | null;
  if (!row) {
    return NextResponse.json({ error: "No VECTA account for that email." }, { status: 404 });
  }

  const auth = getFirebaseAdminAuth();

  try {
    const existing = await auth.getUserByEmail(email);
    await auth.deleteUser(existing.uid);
  } catch {
    // No existing Firebase user for this email — nothing to delete, fine.
  }

  const created = await auth.createUser({
    uid: row.id,
    email,
    emailVerified: true,
  });

  return NextResponse.json({ uid: created.uid, matchesSupabaseId: created.uid === row.id });
}
