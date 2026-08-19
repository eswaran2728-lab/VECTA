"use server";

import { createClient } from "@/lib/supabase/server";
import { parseCaterLinkQrPayload } from "@/lib/icms/qr-payload";
import { opsGroupForTransaction } from "@/lib/icms/ops-group";
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

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

  const t = tx as {
    id: string;
    status: TransactionStatus;
    direction: Direction;
    route: TransactionRoute;
    transaction_number: string;
  };

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
