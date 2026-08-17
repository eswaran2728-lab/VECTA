import { NextRequest, NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { verifyQrToken } from "@/lib/qr-token";
import { nextStepFor } from "@/lib/workflow";
import { vendorNextStepFor } from "@/lib/workflow-vendor";
import type { Database, Role, Transaction, VendorTransaction } from "@/lib/database.types";

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

/**
 * Vendor Movement Module lookup — mirrors the catering path below but
 * against vendor_transactions/workflow-vendor.ts. Only post2_avsec and
 * warehouse_pic participate in this flow (post6_avsec/receiver don't).
 */
async function handleVendorLookup(
  supabase: SupabaseClient<Database>,
  role: Role | undefined,
  by: { transactionId: string | null; transactionNumber: string }
): Promise<NextResponse> {
  const { data: tx } = await supabase
    .from("vendor_transactions")
    .select("id, status, transaction_number")
    .eq(by.transactionId ? "id" : "transaction_number", by.transactionId ?? by.transactionNumber)
    .maybeSingle();

  if (!tx) {
    return NextResponse.json(
      { error: "Vendor transaction not found. / Transaksi vendor tidak dijumpai." },
      { status: 404 }
    );
  }

  const t = tx as Pick<VendorTransaction, "id" | "status" | "transaction_number">;
  const next = vendorNextStepFor(t.status);

  const checkpointRoles: Role[] = ["post2_avsec", "warehouse_pic"];
  if (next && role && checkpointRoles.includes(role) && next.role !== role) {
    return NextResponse.json(
      {
        error:
          "You are not authorized for this checkpoint — this vendor transaction is waiting on a different step. " +
          "/ Anda tidak dibenarkan untuk langkah ini — transaksi vendor ini sedang menunggu langkah yang lain.",
      },
      { status: 403 }
    );
  }

  const actionable = !!next && next.role === role;
  const redirectPath = actionable
    ? `/vendor-transactions/${t.id}/${next.slug}`
    : `/vendor-transactions/${t.id}`;

  return NextResponse.json({
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    status: t.status,
    actionable,
    redirectPath,
    nextStep: next ? { part: next.part, slug: next.slug, role: next.role } : null,
  });
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

  const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single();
  const role = profile?.role as Role | undefined;

  const token = request.nextUrl.searchParams.get("token") ?? "";
  const transactionNumber = request.nextUrl.searchParams.get("number")?.trim().toUpperCase() ?? "";
  let transactionId: string | null = null;
  let tokenType: "CATERING" | "VENDOR" = "CATERING";

  if (token) {
    const result = verifyQrToken(token);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    transactionId = result.transactionId;
    tokenType = result.type;
  } else if (/^VMS-\d{4}-\d{6}$/.test(transactionNumber)) {
    tokenType = "VENDOR";
  } else if (!/^(ICMS|CSCS)-\d{4}-\d{6}$/.test(transactionNumber)) {
    // Accepts legacy CSCS-* numbers too, so transactions created before the
    // ICMS rebrand remain look-up-able by their original number.
    return NextResponse.json(
      {
        error:
          "Enter a valid ICMS or VMS transaction number. / Masukkan nombor transaksi ICMS atau VMS yang sah.",
      },
      { status: 400 }
    );
  }

  if (tokenType === "VENDOR") {
    return handleVendorLookup(supabase, role, { transactionId, transactionNumber });
  }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, transaction_number, route")
    .eq(transactionId ? "id" : "transaction_number", transactionId ?? transactionNumber)
    .maybeSingle();

  if (!tx) {
    return NextResponse.json(
      { error: "Transaction not found. / Transaksi tidak dijumpai." },
      { status: 404 }
    );
  }

  const t = tx as Pick<Transaction, "id" | "status" | "direction" | "transaction_number" | "route">;
  const next = nextStepFor(t.direction, t.status, t.route);

  // A checkpoint role (AVSEC Post 2/6, Receiver, Hub AVSEC, REDQ AVSEC)
  // scanning a transaction that is waiting on a DIFFERENT checkpoint is
  // hard-blocked, not shown the read-only detail view — surfacing "not
  // your checkpoint" is more useful (and safer) than a silent fallthrough.
  // PIC/Admin keep read-only access.
  const checkpointRoles: Role[] = [
    "post2_avsec",
    "post6_avsec",
    "receiver",
    "hub_avsec",
    "redq_avsec",
  ];
  if (next && role && checkpointRoles.includes(role) && next.role !== role) {
    return NextResponse.json(
      {
        error:
          "You are not authorized for this checkpoint — this transaction is waiting on a different post. " +
          "/ Anda tidak dibenarkan untuk pusat pemeriksaan ini — transaksi ini sedang menunggu pos yang lain.",
      },
      { status: 403 }
    );
  }

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
