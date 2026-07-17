import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { verifyQrToken } from "@/lib/qr-token";
import { nextStepFor } from "@/lib/workflow";
import type { Role, Transaction } from "@/lib/database.types";

export const dynamic = "force-dynamic";

/**
 * Best-effort per-IP rate limit (30 validations/minute). In serverless
 * deployments each instance keeps its own window, which still bounds
 * brute-force attempts per instance.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  if (hits.size > 10_000) hits.clear();
  return entry.count > MAX_PER_WINDOW;
}

export async function GET(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many attempts — wait a minute. / Terlalu banyak cubaan." },
      { status: 429 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const token = request.nextUrl.searchParams.get("token") ?? "";
  const transactionNumber = request.nextUrl.searchParams.get("number")?.trim().toUpperCase() ?? "";
  let transactionId: string | null = null;

  if (token) {
    const result = verifyQrToken(token);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    transactionId = result.transactionId;
  } else if (!/^(ICMS|CSCS)-\d{4}-\d{6}$/.test(transactionNumber)) {
    // Accepts legacy CSCS-* numbers too, so transactions created before the
    // ICMS rebrand remain look-up-able by their original number.
    return NextResponse.json(
      { error: "Enter a valid ICMS transaction number. / Masukkan nombor transaksi ICMS yang sah." },
      { status: 400 }
    );
  }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, transaction_number")
    .eq(transactionId ? "id" : "transaction_number", transactionId ?? transactionNumber)
    .maybeSingle();

  if (!tx) {
    return NextResponse.json(
      { error: "Transaction not found. / Transaksi tidak dijumpai." },
      { status: 404 }
    );
  }

  const t = tx as Pick<Transaction, "id" | "status" | "direction" | "transaction_number">;
  const next = nextStepFor(t.direction, t.status);
  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = profile?.role as Role | undefined;
  const actionable = !!next && next.role === role;
  const redirectPath = actionable
    ? `/transactions/${t.id}/${next.slug}`
    : `/transactions/${t.id}`;

  return NextResponse.json({
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    status: t.status,
    direction: t.direction,
    actionable,
    redirectPath,
    nextStep: next ? { part: next.part, slug: next.slug, role: next.role } : null,
  });
}
