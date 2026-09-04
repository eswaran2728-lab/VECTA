import { NextRequest, NextResponse } from "next/server";
import { getBearerAuth } from "@/lib/auth/providers/supabase";
import { generateQrToken, type QrTokenType } from "@/lib/icms/qr-token";

export const dynamic = "force-dynamic";

/**
 * CaterLink-facing QR-pass minting endpoint.
 *
 * VECTA holds QR_TOKEN_SECRET; CaterLink (a separately deployed app) does
 * not and should not — so it cannot call generateQrToken() itself. This is
 * the seam: after CaterLink inserts its own row directly into
 * transactions/vendor_transactions (per the confirmed integration model —
 * no parallel/duplicate transaction records), it calls this endpoint with
 * that row's id to get back the signed pass to encode as the QR shown to
 * the driver.
 *
 * Auth: bearer a Supabase access token for the same shared Supabase
 * project/auth (cookie-based auth doesn't cross the two apps' origins).
 * Authorization is ownership-based (caller must be the row's created_by),
 * not role-based, since the ICMS roles that used to create these
 * transactions (warehouse_pic/vendor) are being retired in favor of
 * CaterLink's own accounts — those accounts still need a row in
 * public.users for the transactions/vendor_transactions created_by FK to
 * resolve, but this endpoint doesn't hardcode which role that row carries.
 *
 * Idempotent: if the row already has a qr_token, that same token is
 * returned rather than minting a new one — a token already printed and
 * shown to a driver in transit must keep working.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  if (hits.size > 10_000) hits.clear();
  return entry.count > MAX_PER_WINDOW;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) {
    return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });
  }

  const { user, client: supabase } = await getBearerAuth(bearer);
  if (!user) {
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 401 });
  }

  if (rateLimited(user.id)) {
    return NextResponse.json({ error: "Too many requests — wait a minute." }, { status: 429 });
  }

  let body: { transactionId?: string; type?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const transactionId = (body.transactionId ?? "").trim();
  const type = body.type as QrTokenType;
  if (!UUID_RE.test(transactionId)) {
    return NextResponse.json({ error: "transactionId must be a valid UUID." }, { status: 400 });
  }
  if (type !== "CATERING" && type !== "VENDOR") {
    return NextResponse.json({ error: 'type must be "CATERING" or "VENDOR".' }, { status: 400 });
  }

  const table = type === "VENDOR" ? "vendor_transactions" : "transactions";
  const { data: tx, error: txError } = await supabase
    .from(table)
    .select("id, created_by, qr_token")
    .eq("id", transactionId)
    .maybeSingle();

  if (txError || !tx) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }
  if (tx.created_by !== user.id) {
    return NextResponse.json(
      { error: "Only the account that created this transaction may mint its QR pass." },
      { status: 403 }
    );
  }

  if (tx.qr_token) {
    return NextResponse.json({ qrToken: tx.qr_token });
  }

  const qrToken = generateQrToken(transactionId, type);
  const { error: updateError } = await supabase
    .from(table)
    .update({ qr_token: qrToken })
    .eq("id", transactionId);

  if (updateError) {
    return NextResponse.json({ error: "Could not save QR pass." }, { status: 500 });
  }

  return NextResponse.json({ qrToken });
}
