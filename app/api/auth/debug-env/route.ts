import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY Phase 3 diagnostic — delete alongside dev-migrate-user and
 * debug-profile before Phase 4. Reports only whether each NEXT_PUBLIC_
 * Firebase var is present and its length — never the actual value — to
 * settle "is the env var actually in THIS deployment's build" without
 * relying on Vercel dashboard screenshots, which have repeatedly shown
 * stale/misleading state during this testing session.
 */
export async function GET() {
  const keys = [
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_AVSEC_WORKSPACE_DOMAIN",
    "NEXT_PUBLIC_AUTH_PROVIDER",
    "AUTH_PROVIDER",
    "AVSEC_WORKSPACE_DOMAIN",
  ] as const;

  const report = Object.fromEntries(
    keys.map((k) => [k, { isSet: Boolean(process.env[k]), length: process.env[k]?.length ?? 0 }])
  );

  return NextResponse.json({
    vercelGitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    ...report,
  });
}
