import { NextRequest, NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { verifyQrToken } from "@/lib/icms/qr-token";
import { nextStepFor } from "@/lib/icms/workflow";
import { vendorNextStepFor } from "@/lib/icms/workflow-vendor";
import { assignmentsFromRpcRows, deriveCanonicalAccess } from "@/lib/auth/canonical-access";
import { decideCheckpointAccess, hubDestinationError, isExternalIcmsRole, isStationOperator } from "@/lib/icms/canonical";
import type { Role, Transaction, VendorTransaction } from "@/lib/icms/database.types";
import type { Database } from "@/lib/supabase/database.types";

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
interface ScanActor {
  /** Canonical station operator at a scan-capable station (decided from assignments + capability). */
  canonicalCanAct: boolean;
  /** Only for external CaterLink parties (no canonical role): their legacy ICMS role. */
  externalRole?: Role;
  stationCode: string | null;
}

async function handleVendorLookup(
  supabase: SupabaseClient<Database>,
  actor: ScanActor,
  by: { transactionId: string | null; transactionNumber: string }
): Promise<NextResponse> {
  const { data: tx } = await supabase
    .from("caterlink_vendor_deliveries" as never)
    .select("id, status, delivery_number")
    .eq(by.transactionId ? "id" : "delivery_number", by.transactionId ?? by.transactionNumber)
    .maybeSingle();

  if (!tx) {
    return NextResponse.json(
      { error: "Vendor transaction not found. / Transaksi vendor tidak dijumpai." },
      { status: 404 }
    );
  }

  const row = tx as unknown as { id: string; status: VendorTransaction["status"]; delivery_number: string };
  const t = { id: row.id, status: row.status, transaction_number: row.delivery_number };
  const next = vendorNextStepFor(t.status);

  // Canonical station operators may complete the Post 2 step; the warehouse step belongs to the
  // external warehouse party (legacy external identity). Nothing here reads ops_group.
  const actionable = !!next && (actor.externalRole ? next.role === actor.externalRole : actor.canonicalCanAct && next.role === "post2_avsec");
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

  // Canonical authority: the caller's active Phase 3 assignments plus the approved CaterLink
  // station-capability model. A legacy ICMS users row is consulted ONLY for external
  // CaterLink parties (vendor / warehouse_pic) who hold no canonical assignment.
  const { data: assignmentRows } = await supabase.rpc("get_my_active_role_assignments");
  const access = deriveCanonicalAccess(assignmentsFromRpcRows(assignmentRows));
  const actor: ScanActor = { canonicalCanAct: false, stationCode: access.stationCode };
  if (access.hasAssignment) {
    if (isStationOperator(access)) {
      let capable: boolean | null = null;
      if (access.stationCode) {
        const { data } = await supabase.rpc("can_user_scan_caterlink", { p_station_code: access.stationCode });
        capable = data === true;
      }
      const decision = decideCheckpointAccess(access, capable);
      if (!decision.allowed) {
        return NextResponse.json(
          { error: "CaterLink scanning is not available for your station or role. / Pengimbasan CaterLink tidak tersedia untuk stesen atau peranan anda." },
          { status: 403 }
        );
      }
      actor.canonicalCanAct = true;
    }
  } else {
    const { data: legacy } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
    if (!isExternalIcmsRole(legacy?.role as string | undefined)) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }
    actor.externalRole = legacy?.role as Role;
  }

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
    return handleVendorLookup(supabase, actor, { transactionId, transactionNumber });
  }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, transaction_number, route, hub_destination")
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

  // Merged operations model: there is no per-post identity. A canonical station operator
  // at a scan-capable station may complete whichever step is next, except that the Part Hub
  // step belongs to the destination hub station (station codes decide, not a group).
  let actionable = false;
  if (next) {
    if (actor.externalRole) {
      actionable = next.role === actor.externalRole;
    } else if (actor.canonicalCanAct) {
      const hubError = hubDestinationError({
        nextStepPart: next.part,
        route: t.route,
        hubDestination: (tx as { hub_destination?: string | null }).hub_destination,
        userStation: actor.stationCode,
      });
      if (hubError) {
        return NextResponse.json({ error: hubError }, { status: 403 });
      }
      actionable = true;
    }
  }
  const redirectPath = actionable
    ? `/transactions/${t.id}/${next!.slug}`
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
