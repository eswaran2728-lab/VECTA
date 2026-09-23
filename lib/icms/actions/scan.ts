"use server";

import { createClient } from "@/lib/supabase/server";
import { parseCaterLinkQrPayload } from "@/lib/icms/qr-payload";
import {
  opsGroupForTransaction,
  opsGroupForCheckpointRole,
  opsGroupCanAccessCheckpoint,
  isAvsecScanGroup,
} from "@/lib/icms/ops-group";
import { verifyQrToken } from "@/lib/icms/qr-token";
import { nextStepFor } from "@/lib/icms/workflow";
import { vendorNextStepFor } from "@/lib/icms/workflow-vendor";
import { hasOpenDutyCheckIn } from "@/lib/avsec/duty/checkin-queries";
import { NOT_ON_DUTY_ERROR } from "@/lib/icms/checkpoint-duty";
import type { Direction, OpsGroup, TransactionRoute, TransactionStatus, VendorTransactionStatus } from "@/lib/icms/database.types";

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

  // Unified AVSEC scanning model: any approved ASO/SO/DSE in Operation or
  // IFC AVSEC may scan/process non-Hub CaterLink checkpoints — the
  // per-role denials that used to block SO (Operation branch) and DSE
  // outright were specific to the old two-group model and no longer
  // apply. Hub AVSEC keeps its own exact-match scope, enforced below by
  // opsGroupCanAccessCheckpoint / the transaction-specific checks.
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
  const userStation = (profile as { station?: string | null }).station ?? null;
  // On-duty gate (2026-09-23): "Approved ASO/SO/DSE users from both AVSEC
  // groups may complete non-Hub checkpoints only while checked in." Scoped
  // to isAvsecScanGroup (operation_avsec/ifc_avsec) — the exact grant this
  // task scopes the requirement to — mirroring requireCheckpointRole()'s
  // own scoping (lib/icms/auth.ts). Org-wide viewers hold no checkpoint at
  // all, and Hub AVSEC's own exact-match scope is untouched (out of scope
  // here; task says "non-Hub checkpoints"), so both are treated as
  // trivially "on duty" here — computed only where it can actually gate
  // anything. Reuses the exact same duty source of truth as
  // requireCheckpointRole() and report submission
  // (lib/avsec/reports/actions.ts), so "can I be routed to the form" and
  // "can I actually submit it" never disagree.
  const onDuty = orgWide || !isAvsecScanGroup(userOpsGroup) ? true : await hasOpenDutyCheckIn(user.id);

  const tokenResult = verifyQrToken(ref);
  if (tokenResult.ok) {
    if (tokenResult.type === "VENDOR") {
      return resolveVendorTransaction(supabase, tokenResult.transactionId, orgWide, userOpsGroup, onDuty);
    }
    return resolveCateringTransaction(supabase, tokenResult.transactionId, orgWide, userOpsGroup, userStation, onDuty);
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

  return resolveCateringRow(tx as {
    id: string;
    status: TransactionStatus;
    direction: Direction;
    route: TransactionRoute;
    transaction_number: string;
    hub_destination?: string | null;
  }, orgWide, userOpsGroup, userStation, onDuty);
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

function resolveCateringRow(
  t: { id: string; status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string; hub_destination?: string | null },
  orgWide: boolean,
  userOpsGroup: OpsGroup | null,
  userStation: string | null | undefined,
  onDuty: boolean
): ScanResult {
  // Which checkpoint slug (if any) this scan should land the user on
  // directly, instead of the read-only transaction page. Previously this
  // action always returned the base transaction page — Part B/C/D/REDQ's
  // form and submit button never rendered from a scan even when the
  // scanning officer was fully authorized to complete that checkpoint
  // (requireCheckpointRole() on the part-b/c/d/redq pages already accepted
  // them; nothing ever linked there). Mirrors requireCheckpointRole's own
  // unified-AVSEC-scanning check (opsGroupCanAccessCheckpoint) so "can view"
  // here and "can submit" on the checkpoint page agree exactly. Org-wide
  // roles (admin/management/enforcement) hold no checkpoint role and never
  // get routed to a checkpoint form, same as before.
  let actionableSlug: string | null = null;

  if (!orgWide) {
    const txOpsGroup = opsGroupForTransaction(t.direction, t.status, t.route);
    if (!opsGroupCanAccessCheckpoint(userOpsGroup, txOpsGroup)) {
      return { error: "This transaction is not in your ops group." };
    }
    if (
      userOpsGroup === "hub_avsec" &&
      userStation &&
      ["PEN", "JHB", "NILAI"].includes(userStation) &&
      t.route === "HUB" &&
      t.hub_destination &&
      userStation !== t.hub_destination
    ) {
      return {
        error: `This Hub transaction is destined for ${t.hub_destination}, not your station (${userStation}).`,
      };
    }

    const next = nextStepFor(t.direction, t.status, t.route);
    if (next && opsGroupCanAccessCheckpoint(userOpsGroup, opsGroupForCheckpointRole(next.role))) {
      // On-duty gate: this checkpoint IS this officer's to complete, but
      // they have no open duty check-in — reject the scan outright rather
      // than silently falling back to the read-only page, so "off duty"
      // reads as a clear, actionable rejection instead of an unexplained
      // missing form.
      if (!onDuty) return { error: NOT_ON_DUTY_ERROR };
      actionableSlug = next.slug;
    }
  }

  return {
    error: null,
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    redirectPath: actionableSlug
      ? `/icms/transactions/${t.id}/${actionableSlug}`
      : `/icms/transactions/${t.id}`,
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
  userOpsGroup: OpsGroup | null,
  userStation: string | null | undefined,
  onDuty: boolean
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, direction, route, transaction_number, hub_destination")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Transaction not found for this QR pass." };
  return resolveCateringRow(
    tx as { id: string; status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string; hub_destination?: string | null },
    orgWide,
    userOpsGroup,
    userStation,
    onDuty
  );
}

/**
 * Vendor Supply transactions (vendor_transactions/vendor_part_a-c) have no
 * direction/route of their own — the whole route is Post 2 -> Warehouse.
 * Historically fixed to IFC territory only; under the unified AVSEC
 * scanning model any Operation or IFC ASO/SO/DSE may process it (scope is
 * fixed to the AVSEC scan group rather than derived from
 * opsGroupForTransaction, which only knows the catering-flow tables).
 */
async function resolveVendorTransaction(
  supabase: SupabaseClient,
  transactionId: string,
  orgWide: boolean,
  userOpsGroup: OpsGroup | null,
  onDuty: boolean
): Promise<ScanResult> {
  const { data: tx } = await supabase
    .from("vendor_transactions")
    .select("id, transaction_number, status")
    .eq("id", transactionId)
    .maybeSingle();
  if (!tx) return { error: "Vendor transaction not found for this QR pass." };
  const t = tx as { id: string; transaction_number: string; status: VendorTransactionStatus };

  if (!orgWide && !isAvsecScanGroup(userOpsGroup)) {
    return { error: "This transaction is not in your ops group." };
  }

  // Only Part B (post2_avsec) is reachable through an AVSEC ops_group here —
  // Part C is warehouse_pic's own ICMS role, unrelated to ops_group, and
  // opsGroupForCheckpointRole("warehouse_pic") returns null, so it's never
  // made actionable via this path.
  let actionableSlug: string | null = null;
  if (!orgWide) {
    const next = vendorNextStepFor(t.status);
    if (next && opsGroupCanAccessCheckpoint(userOpsGroup, opsGroupForCheckpointRole(next.role))) {
      if (!onDuty) return { error: NOT_ON_DUTY_ERROR };
      actionableSlug = next.slug;
    }
  }

  return {
    error: null,
    transactionId: t.id,
    transactionNumber: t.transaction_number,
    redirectPath: actionableSlug
      ? `/icms/vendor-transactions/${t.id}/${actionableSlug}`
      : `/icms/vendor-transactions/${t.id}`,
  };
}
