"use server";

import { createClient } from "@/lib/supabase/server";
import { resolveOperatorScope } from "@/lib/auth/operator-scope";
import { STATION_OPERATOR_CODES, hubDestinationError } from "@/lib/icms/canonical";
import { parseCaterLinkQrPayload } from "@/lib/icms/qr-payload";
import { verifyQrToken } from "@/lib/icms/qr-token";
import { nextStepFor } from "@/lib/icms/workflow";
import { vendorNextStepFor } from "@/lib/icms/workflow-vendor";
import { hasOpenDutyCheckIn } from "@/lib/avsec/duty/checkin-queries";
import { NOT_ON_DUTY_ERROR } from "@/lib/icms/checkpoint-duty";
import type { Direction, TransactionRoute, TransactionStatus, VendorTransactionStatus } from "@/lib/icms/database.types";

export interface ScanResult {
  error: string | null;
  transactionId?: string;
  transactionNumber?: string;
  redirectPath?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_RE = /^(ICMS|CSCS)-\d{4}-\d{6}$/i;

/**
 * Unified scan entry point (drives the "Scan" section of the unified
 * dashboard, app/page.tsx).
 *
 * Merged operations model: authority is the caller's active Phase 3
 * assignments plus the approved CaterLink station-capability model. ops_group
 * is not consulted. A station operator (aso/so/sso/dse) may scan and complete
 * checkpoints only at a single assigned station that holds the SCAN
 * capability (stations without it, e.g. BTU, are denied), while checked in
 * for duty. Management/enforcement leadership may look a transaction up
 * (view only). Staff Profiling is always excluded.
 */
export async function scanTransaction(raw: string): Promise<ScanResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const scope = await resolveOperatorScope(supabase);
  if (!scope.source) return { error: "No VECTA profile — contact an admin." };

  if (scope.roleCodes.some((code) => code === "profiling_so" || code === "profiling_aso")) {
    return { error: "Staff Profiling accounts are not authorized to scan CaterLink transactions." };
  }

  const stationOperator = scope.roleCodes.some((code) => (STATION_OPERATOR_CODES as readonly string[]).includes(code));
  const orgWide = scope.orgWide;
  if (!stationOperator && !orgWide) {
    return { error: "Your role is not authorized to scan CaterLink transactions." };
  }

  const userStation = scope.station;
  if (stationOperator && !orgWide) {
    if (!userStation) return { error: "Your account has no single assigned station — contact an admin." };
    // Approved station-capability model: fail closed unless the station is explicitly scan-capable.
    const { data: canScanStation } = await supabase.rpc("can_user_scan_caterlink", { p_station_code: userStation });
    if (canScanStation !== true) {
      return { error: `CaterLink scanning is disabled for station ${userStation}.` };
    }
  }

  const payload = parseCaterLinkQrPayload(raw);
  if (!payload) return { error: "Could not read this QR code." };
  const ref = payload.transactionId.trim();

  // On duty is required only where it can gate something: a station operator completing a checkpoint.
  const onDuty = stationOperator && !orgWide ? await hasOpenDutyCheckIn(user.id) : true;
  const canActOnCheckpoints = stationOperator && !orgWide;

  const tokenResult = verifyQrToken(ref);
  if (tokenResult.ok) {
    if (tokenResult.type === "VENDOR") {
      return resolveVendorTransaction(supabase, tokenResult.transactionId, canActOnCheckpoints, onDuty);
    }
    return resolveCateringTransaction(supabase, tokenResult.transactionId, canActOnCheckpoints, userStation, onDuty);
  }

  let lookup = supabase.from("transactions").select("id, status, direction, route, transaction_number, hub_destination");
  if (UUID_RE.test(ref)) {
    lookup = lookup.eq("id", ref);
  } else if (NUMBER_RE.test(ref)) {
    lookup = lookup.eq("transaction_number", ref.toUpperCase());
  } else {
    return { error: "Not a recognised transaction reference." };
  }

  const { data: tx } = await lookup.maybeSingle();
  if (!tx) return { error: "Transaction not found." };

  return resolveCateringRow(tx as CateringRow, canActOnCheckpoints, userStation, onDuty);
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

interface CateringRow {
  id: string;
  status: TransactionStatus;
  direction: Direction;
  route: TransactionRoute;
  transaction_number: string;
  hub_destination?: string | null;
}

function resolveCateringRow(t: CateringRow, canActOnCheckpoints: boolean, userStation: string | null | undefined, onDuty: boolean): ScanResult {
  let actionableSlug: string | null = null;

  if (canActOnCheckpoints) {
    const next = nextStepFor(t.direction, t.status, t.route);
    if (next) {
      // At the Part Hub step only the destination hub station may proceed (station codes decide, not a group).
      const hubError = hubDestinationError({ nextStepPart: next.part, route: t.route, hubDestination: t.hub_destination, userStation });
      if (hubError) return { error: hubError };
      // This checkpoint is the officer's to complete but they are not checked in: reject outright
      // rather than silently showing a read-only page.
      if (!onDuty) return { error: NOT_ON_DUTY_ERROR };
      actionableSlug = next.slug;
    }
  }

  return {
    error: null,
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    redirectPath: actionableSlug ? `/icms/transactions/${t.id}/${actionableSlug}` : `/icms/transactions/${t.id}`,
  };
}

async function resolveCateringTransaction(
  supabase: SupabaseClient,
  transactionId: string,
  canActOnCheckpoints: boolean,
  userStation: string | null | undefined,
  onDuty: boolean
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, route, transaction_number, hub_destination")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Transaction not found for this QR pass." };
  return resolveCateringRow(tx as CateringRow, canActOnCheckpoints, userStation, onDuty);
}

/**
 * Vendor Supply transactions have no direction/route of their own: the whole
 * route is Post 2 -> Warehouse. Any scan-capable station operator may process
 * the Post 2 step; Part C belongs to the external warehouse party and is never
 * made actionable here.
 */
async function resolveVendorTransaction(
  supabase: SupabaseClient,
  transactionId: string,
  canActOnCheckpoints: boolean,
  onDuty: boolean
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("vendor_transactions")
    .select("id, transaction_number, status")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Vendor transaction not found for this QR pass." };
  const t = tx as { id: string; transaction_number: string; status: VendorTransactionStatus };

  let actionableSlug: string | null = null;
  if (canActOnCheckpoints) {
    const next = vendorNextStepFor(t.status);
    if (next && next.role === "post2_avsec") {
      if (!onDuty) return { error: NOT_ON_DUTY_ERROR };
      actionableSlug = next.slug;
    }
  }

  return {
    error: null,
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    redirectPath: actionableSlug ? `/icms/vendor-transactions/${t.id}/${actionableSlug}` : `/icms/vendor-transactions/${t.id}`,
  };
}
