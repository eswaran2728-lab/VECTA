"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { uploadDataUrl } from "@/lib/icms/storage";
import { regenerateFinalPdfAfterReceipt } from "@/lib/icms/completed-form-pdf";

/**
 * BKI / KCH final-receipt workflow. Receipt only: no scanner, no stream, no Post 2 / Post 6 repetition. The station capability table
 * (can_user_confirm_caterlink_receipt) is the authority; the RPC re-checks it, the transaction/route/destination and status, records the
 * receiver, station and timestamp, audits the confirmation and notifies the sender. The discrepancy (if any) is recorded in the remarks.
 */
export interface PendingReceipt {
  id: string;
  transactionNumber: string;
  direction: string;
  route: string | null;
  status: string | null;
  vehicleNumber: string;
  driverName: string;
  sealNumber: string | null;
  flightNumber: string | null;
  aircraftRegistration: string | null;
  trolleyCount: number | null;
  originStation: string | null;
  destinationStation: string | null;
  createdAt: string;
}

export async function listPendingReceipts(stationCode: string): Promise<{ ok: boolean; rows: PendingReceipt[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_caterlink_pending_receipts_secure", { p_station_code: stationCode });
  if (error) return { ok: false, rows: [], error: "Final receipt is not available at this station." };
  return {
    ok: true,
    error: null,
    rows: (data ?? []).map((r) => ({
      id: r.id, transactionNumber: r.transaction_number, direction: r.direction, route: r.route, status: r.status, vehicleNumber: r.vehicle_number,
      driverName: r.driver_name, sealNumber: r.seal_number, flightNumber: r.flight_number, aircraftRegistration: r.aircraft_registration,
      trolleyCount: r.trolley_count, originStation: r.origin_station, destinationStation: r.destination_station, createdAt: r.created_at,
    })),
  };
}

export interface ReceiptResult {
  ok: boolean;
  error: string | null;
  /** Version of the regenerated final PDF, or null when regeneration is pending (the receipt itself is committed either way). */
  pdfVersion?: number | null;
}

export async function confirmFinalReceipt(formData: FormData): Promise<ReceiptResult> {
  const profile = await requireProfile();
  const transactionId = String(formData.get("transactionId") || "");
  const station = String(formData.get("station") || "");
  const signature = String(formData.get("signature") || "");
  const routeOk = formData.get("routeOk") === "on";
  const sealOk = formData.get("sealOk") === "on";
  const deliveryOk = formData.get("deliveryOk") === "on";
  const discrepancy = String(formData.get("discrepancy") || "").trim();

  if (!transactionId || !station) return { ok: false, error: "A transaction and station are required." };
  if (!signature) return { ok: false, error: "The receiver's signature is required." };
  const allOk = routeOk && sealOk && deliveryOk;
  if (!allOk && discrepancy.length < 5) {
    return { ok: false, error: "Describe the discrepancy: route, seal or delivery details were not confirmed." };
  }

  const supabase = await createClient();
  // Authorize BEFORE storing anything (the RPC checks again, and checks the transaction/route/destination).
  const { data: allowed } = await supabase.rpc("can_user_confirm_caterlink_receipt", { p_station_code: station });
  if (allowed !== true) return { ok: false, error: "Not authorized to confirm CaterLink receipts at this station." };

  let sig: { path: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "receipt");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const remarks = allOk
    ? "Receipt verified: route, seal and delivery details confirmed."
    : `DISCREPANCY (route ${routeOk ? "ok" : "NOT confirmed"}; seal ${sealOk ? "ok" : "NOT confirmed"}; delivery ${deliveryOk ? "ok" : "NOT confirmed"}): ${discrepancy}`;

  const { error } = await supabase.rpc("confirm_caterlink_destination_receipt_secure", {
    p_transaction_id: transactionId,
    p_station_code: station,
    p_signature_url: sig.path,
    p_remarks: remarks,
  });
  if (error) return { ok: false, error: error.message };

  // The completed form now has its receipt part: regenerate the final PDF as a NEW VERSION (best effort; the receipt is already committed).
  const pdf = await regenerateFinalPdfAfterReceipt(transactionId, profile.id);

  revalidatePath("/avsec/caterlink/receipt");
  return { ok: true, error: null, pdfVersion: pdf.ok ? pdf.version : null };
}
