"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { uploadDataUrl } from "@/lib/storage";
import { generateQrToken } from "@/lib/qr-token";
import { generateVendorCompletedFormPdf } from "@/lib/completed-form-pdf-vendor";
import type { VendorTransaction } from "@/lib/database.types";

export interface ActionState {
  error: string | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Vendor Movement Module Part A: a vendor driver creates their own
 * delivery record. No whitelist check (confirmed decision — open to any
 * vendor, unlike the catering flow's hard-blocked vehicle/driver
 * whitelist). Mirrors createTransaction()'s shape in transactions.ts.
 */
export async function createVendorTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["vendor"]);

  const driverName = str(formData, "driver_name");
  const nricNumber = str(formData, "nric_number");
  const sealNumber = str(formData, "seal_number");
  const signature = str(formData, "signature");

  if (!driverName || !nricNumber || !sealNumber) {
    return { error: "Driver name, NRIC number and seal number are all required." };
  }
  if (!signature) {
    return { error: "Signature is required." };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "vendor-signatures");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const txId = crypto.randomUUID();
  const { data: tx, error: txError } = await supabase
    .from("vendor_transactions")
    .insert({ id: txId, created_by: profile.id, qr_token: generateQrToken(txId, "VENDOR") })
    .select()
    .single();

  if (txError || !tx) {
    return { error: `Could not create vendor transaction: ${txError?.message ?? "unknown error"}` };
  }

  const { error: partError } = await supabase.from("vendor_part_a").insert({
    transaction_id: tx.id,
    driver_name: driverName,
    nric_number: nricNumber,
    seal_number: sealNumber,
    signature_url: sig.path,
    completed_by: profile.id,
  });

  if (partError) {
    return { error: `Part A could not be saved: ${partError.message}` };
  }

  revalidatePath("/vendor-transactions");
  redirect(`/vendor-transactions/${tx.id}?created=1`);
}

/**
 * Part B: AirAsia Security (Post 2) verifies the vendor's vehicle, driver
 * and seal. Status check is UX only — enforce_vendor_part_sequence() is
 * the actual source of truth and rejects an out-of-order insert.
 */
export async function submitVendorPartB(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["post2_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const vehicleRegistrationNo = str(formData, "vehicle_registration_no").toUpperCase();
  const driverName = str(formData, "driver_name");
  const driverNric = str(formData, "driver_nric");
  const sealNumber = str(formData, "seal_number");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!vehicleRegistrationNo || !driverName || !driverNric || !sealNumber) {
    return { error: "Vehicle registration, driver name, NRIC and seal number are all required." };
  }
  if (!signature) return { error: "Signature is required." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("vendor_transactions")
    .select("status")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Vendor transaction not found. / Transaksi vendor tidak dijumpai." };
  const tx = txRow as Pick<VendorTransaction, "status">;
  if (tx.status !== "CREATED") {
    return {
      error: `Out of order: Part B requires status CREATED, but this transaction is ${tx.status}. / Tidak mengikut urutan.`,
    };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "vendor-part-b");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("vendor_part_b").insert({
    transaction_id: transactionId,
    vehicle_registration_no: vehicleRegistrationNo,
    driver_name: driverName,
    driver_nric: driverNric,
    seal_number: sealNumber,
    remarks: remarks || null,
    signature_url: sig.path,
    avsec_name: profile.name,
    avsec_staff_id: profile.staff_id,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Part B could not be saved: ${error.message}` };
  }

  revalidatePath(`/vendor-transactions/${transactionId}`);
  revalidatePath("/vendor-transactions");
  redirect(`/vendor-transactions/${transactionId}?approved=1`);
}

/**
 * Part C: Warehouse (In-Flight), dual certification. Single submission
 * captures BOTH the warehouse PIC's and the vendor driver's signatures —
 * the vendor driver's identity is derived server-side from vendor_part_a
 * (never trust a client-supplied user id for whose signature this is).
 */
export async function submitVendorPartC(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["warehouse_pic"]);

  const transactionId = str(formData, "transaction_id");
  const warehouseSignature = str(formData, "warehouse_signature");
  const vendorSignature = str(formData, "vendor_signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!warehouseSignature || !vendorSignature) {
    return {
      error:
        "Both the Warehouse PIC signature and the Vendor Driver signature are required. " +
        "/ Kedua-dua tandatangan PIC Gudang dan Pemandu Vendor diperlukan.",
    };
  }

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("vendor_transactions")
    .select("status")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Vendor transaction not found. / Transaksi vendor tidak dijumpai." };
  const tx = txRow as Pick<VendorTransaction, "status">;
  if (tx.status !== "SECURITY_VERIFIED" && tx.status !== "PART_C_PARTIAL") {
    return {
      error: `Out of order: Part C requires status SECURITY_VERIFIED or PART_C_PARTIAL, but this transaction is ${tx.status}. / Tidak mengikut urutan.`,
    };
  }

  // Derive the vendor driver's identity server-side from their own Part A
  // record, rather than trusting a client-supplied id — vendor_part_a was
  // written by the vendor themselves when they created the transaction.
  const { data: vendorPartA } = await supabaseForCheck
    .from("vendor_part_a")
    .select("driver_name, completed_by")
    .eq("transaction_id", transactionId)
    .single();

  if (!vendorPartA) {
    return { error: "Vendor Part A record not found — cannot identify the vendor driver." };
  }

  let warehousePath: { path: string; sha256: string };
  let vendorPath: { path: string; sha256: string };
  try {
    [warehousePath, vendorPath] = await Promise.all([
      uploadDataUrl("signatures", warehouseSignature, "vendor-part-c-warehouse"),
      uploadDataUrl("signatures", vendorSignature, "vendor-part-c-vendor"),
    ]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const signedAt = new Date().toISOString();
  const { data: existing } = await supabase
    .from("vendor_part_c")
    .select("id")
    .eq("transaction_id", transactionId)
    .maybeSingle();

  const row = {
    warehouse_pic_id: profile.id,
    warehouse_pic_name: profile.name,
    warehouse_signature_url: warehousePath.path,
    warehouse_signed_at: signedAt,
    vendor_driver_id: vendorPartA.completed_by,
    vendor_driver_name: vendorPartA.driver_name,
    vendor_signature_url: vendorPath.path,
    vendor_signed_at: signedAt,
  };

  const { error } = existing
    ? await supabase.from("vendor_part_c").update(row).eq("id", existing.id)
    : await supabase.from("vendor_part_c").insert({ transaction_id: transactionId, ...row });

  if (error) {
    return { error: `Part C could not be saved: ${error.message}` };
  }

  await generateVendorCompletedFormPdf(transactionId);

  revalidatePath(`/vendor-transactions/${transactionId}`);
  revalidatePath("/vendor-transactions");
  redirect(`/vendor-transactions/${transactionId}?completed=1`);
}
