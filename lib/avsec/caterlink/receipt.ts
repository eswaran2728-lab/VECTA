"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { captureOutcome, settleSignature, uploadSignature } from "@/lib/icms/signature-storage";
import { signatureDeps } from "@/lib/icms/signature-runtime";
import { runCaterlinkPdfJobs } from "@/lib/icms/completed-form-pdf";

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
  /** Version of the authoritative final PDF, or null while it is pending / failed (the receipt itself is committed either way; a durable job retries it). */
  pdfVersion?: number | null;
}

export async function confirmFinalReceipt(formData: FormData): Promise<ReceiptResult> {
  await requireProfile();
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

  // The path is derived here (receipt/<this movement>/<random>); Storage RLS lets only an officer who may confirm receipt of THIS movement now write it.
  const sigDeps = await signatureDeps();
  let sig: { path: string };
  try {
    sig = await uploadSignature("receipt", transactionId, signature, sigDeps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const remarks = allOk
    ? "Receipt verified: route, seal and delivery details confirmed."
    : `DISCREPANCY (route ${routeOk ? "ok" : "NOT confirmed"}; seal ${sealOk ? "ok" : "NOT confirmed"}; delivery ${deliveryOk ? "ok" : "NOT confirmed"}): ${discrepancy}`;

  const outcome = await captureOutcome(() => supabase.rpc("confirm_caterlink_destination_receipt_secure", {
    p_transaction_id: transactionId,
    p_station_code: station,
    p_signature_url: sig.path,
    p_remarks: remarks,
  }));
  await settleSignature(sig.path, sigDeps, { error: outcome.error, thrown: outcome.thrown });
  if (outcome.thrown) return { ok: false, error: "The receipt could not be confirmed." };
  const error = outcome.result?.error ?? null;
  if (error) return { ok: false, error: error.message };

  // The receipt committed together with a durable PDF job (database trigger). Try it now; if it fails the job stays queued and is retried, and
  // the screen says the PDF is pending -- a final PDF is only reported once the authoritative version exists.
  let pdfVersion: number | null = null;
  try {
    const outcomes = await runCaterlinkPdfJobs({ transactionId, limit: 1 });
    pdfVersion = outcomes.find((o) => o.ok)?.version ?? null;
  } catch {
    pdfVersion = null;
  }

  revalidatePath("/avsec/caterlink/receipt");
  return { ok: true, error: null, pdfVersion };
}
