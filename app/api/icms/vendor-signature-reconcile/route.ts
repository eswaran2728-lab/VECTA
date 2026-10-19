import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reconcileSignatureOrphans } from "@/lib/icms/signature-storage";
import { signatureDeps } from "@/lib/icms/signature-runtime";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60; // a paged run checks each candidate's reference; allow it time to finish

function authorised(header: string | null, secret: string): boolean {
  const given = Buffer.from(header ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Scheduled (Vercel Cron) durable clean-up of signature objects (every approved prefix) whose save failed. Fails closed without CRON_SECRET. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 503 });
  if (!authorised(request.headers.get("authorization"), secret)) return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  const result = await reconcileSignatureOrphans(await signatureDeps(), 30);
  return NextResponse.json(result, { status: result.failed ? 502 : 200, headers: { "Cache-Control": "no-store" } });
}
