"use server";

import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth/guards";
import { parseCaterLinkQrPayload } from "@/lib/icms/qr-payload";
import { opsGroupForTransaction } from "@/lib/icms/ops-group";
import { verifyQrToken } from "@/lib/icms/qr-token";
import type { Direction, OpsGroup, TransactionRoute, TransactionStatus } from "@/lib/icms/database.types";

export interface ScanResult {
  error: string | null;
  transactionId?: string;
  transactionNumber?: string;
  redirectPath?: string;
}

const ORG_WIDE_UNIFIED_ROLES = ["admin", "management", "enforcement"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_RE = /^(ICMS|CSCS)-\d{4}-\d{6}$/i;

/**
 * Unified scan entry point (drives the "Scan" section of the unified
 * dashboard, app/page.tsx). Works for both AVSEC-origin (public.profiles)
 * and ICMS-origin (public.users) accounts — whichever table the signed-in
 * account actually lives in.
 *
 * The ops_group scope check below is the server-side enforcement point:
 * a non-org-wide user (so/aso/dse) can only ever get transaction data back
 * for a transaction whose current (or, once finished, last-known)
 * checkpoint maps to their own ops_group. This is enforced here, before
 * any transaction data is returned — never only hidden in the UI.
 */
export async function scanTransaction(raw: string): Promise<ScanResult> {
  const user = await getAuthUser();
  if (!user) return { error: "Not signed in." };
  const supabase = await createClient();

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
    supabase.from("users").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
  ]);
  const profile = avsecProfile ?? icmsProfile;
  if (!profile) return { error: "No VECTA profile — contact an admin." };

  const orgWide = ORG_WIDE_UNIFIED_ROLES.includes(profile.unified_role ?? "");
  const userOpsGroup = profile.ops_group as OpsGroup | null;

  if (!orgWide && !userOpsGroup) {
    return { error: "Your account has no ops group assigned — contact an admin." };
  }

  const payload = parseCaterLinkQrPayload(raw);
  if (!payload) return { error: "Could not read this QR code." };
  const ref = payload.transactionId.trim();

  // Signed QR pass (issued by createTransaction/createVendorTransaction's
  // generateQrToken — this is the actual CaterLink-facing contract: a QR
  // encodes this token verbatim, never a bare id/number). Checked before the
  // legacy id/number lookup below, which stays only for manually typed
  // references on VECTA's own transaction detail pages.
  const tokenResult = verifyQrToken(ref);
  if (tokenResult.ok) {
    if (tokenResult.type === "VENDOR") {
      return resolveVendorTransaction(supabase, tokenResult.transactionId, orgWide, userOpsGroup);
    }
    return resolveCateringTransaction(supabase, tokenResult.transactionId, orgWide, userOpsGroup);
  }

  let lookup = supabase.from("transactions").select("id, status, direction, route, transaction_number");
  if (UUID_RE.test(ref)) {
    lookup = lookup.eq("id", ref);
  } else if (NUMBER_RE.test(ref)) {
    lookup = lookup.eq("transaction_number", ref.toUpperCase());
  } else {
    return { error: "Not a recognised transaction reference." };
  }

  const { data: tx } = await lookup.maybeSingle();
  if (!tx) return { error: "Transaction not found." };

  return resolveCateringRow(tx as {
    id: string;
    status: TransactionStatus;
    direction: Direction;
    route: TransactionRoute;
    transaction_number: string;
  }, orgWide, userOpsGroup);
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

function resolveCateringRow(
  t: { id: string; status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string },
  orgWide: boolean,
  userOpsGroup: OpsGroup | null
): ScanResult {
  if (!orgWide) {
    const txOpsGroup = opsGroupForTransaction(t.direction, t.status, t.route);
    if (!txOpsGroup || txOpsGroup !== userOpsGroup) {
      return { error: "This transaction is not in your ops group." };
    }
  }

  return {
    error: null,
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    redirectPath: `/icms/transactions/${t.id}`,
  };
}

/**
 * A transaction whose QR pass was minted before its Part A record exists
 * (CaterLink's own creation flow) is looked up by id here — never create a
 * duplicate/parallel transaction row for a token that doesn't resolve.
 */
async function resolveCateringTransaction(
  supabase: SupabaseClient,
  transactionId: string,
  orgWide: boolean,
  userOpsGroup: OpsGroup | null
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, route, transaction_number")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Transaction not found for this QR pass." };
  return resolveCateringRow(
    tx as { id: string; status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string },
    orgWide,
    userOpsGroup
  );
}

/**
 * Vendor Supply transactions (vendor_transactions/vendor_part_a-c) have no
 * direction/route of their own — the whole route is Post 2 -> Warehouse,
 * IFC territory throughout (see the CaterLink route table: "Vendor supply
 * ... Signs off ... AVSEC IFC"), so scope is fixed rather than derived from
 * opsGroupForTransaction (which only knows the catering-flow tables).
 */
async function resolveVendorTransaction(
  supabase: SupabaseClient,
  transactionId: string,
  orgWide: boolean,
  userOpsGroup: OpsGroup | null
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("vendor_transactions")
    .select("id, transaction_number")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Vendor transaction not found for this QR pass." };

  if (!orgWide && userOpsGroup !== "ifc_avsec") {
    return { error: "This transaction is not in your ops group." };
  }

  return {
    error: null,
    transactionId: tx.id,
    transactionNumber: tx.transaction_number,
    redirectPath: `/icms/vendor-transactions/${tx.id}`,
  };
}
