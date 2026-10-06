"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/icms/auth";
import { uploadDataUrl } from "@/lib/icms/storage";
import { callCaterlinkRpc } from "@/lib/caterlink/vendor";

export interface ActionState {
  error: string | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Strips the Postgres "ERROR:" noise from an RPC failure so the message is user-presentable. */
function rpcMessage(error: { message?: string } | null | undefined): string {
  return (error?.message ?? "Request failed.").replace(/^ERROR:\s*/i, "");
}

/**
 * Third-Party Vendor, Part A: the vendor creates its own delivery (canonical Phase 9 model:
 * create_caterlink_vendor_delivery_secure). The role, the delivery station rule and the record
 * owner are decided by the database from the session; nothing here trusts a client-supplied identity.
 */
export async function createVendorTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireRole(["vendor"]);

  const stationCode = str(formData, "station_code");
  const driverName = str(formData, "driver_name");
  const nricNumber = str(formData, "nric_number");
  const vehicleNo = str(formData, "vehicle_registration_no").toUpperCase();
  const sealNumber = str(formData, "seal_number");
  const supplies = str(formData, "supplies_description");
  const signature = str(formData, "signature");

  if (!stationCode || !driverName || !nricNumber || !vehicleNo || !sealNumber) {
    return { error: "Delivery station, driver name, NRIC, vehicle registration and seal number are all required." };
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
  const { data, error } = await callCaterlinkRpc(supabase, "create_caterlink_vendor_delivery_secure", {
    p_station_code: stationCode,
    p_driver_name: driverName,
    p_driver_nric: nricNumber,
    p_vehicle_registration_no: vehicleNo,
    p_seal_number: sealNumber,
    p_signature_url: sig.path,
    p_signature_hash: sig.sha256,
    p_supplies_description: supplies || undefined,
  });
  const created = Array.isArray(data) ? data[0] : data;
  if (error || !created?.delivery_id) {
    return { error: `Could not create the delivery: ${rpcMessage(error)}` };
  }

  revalidatePath("/icms/vendor-transactions");
  redirect(`/icms/vendor-transactions/${created.delivery_id}?created=1`);
}

/**
 * Part B: the security check at the delivery station, by a scan-authorised officer. The database
 * decides who is authorised (can_user_scan_caterlink: the approved PEN/JHB scope, unchanged); the
 * officer's identity is taken from the session profile. Observed values are stored as evidence.
 */
export async function submitVendorPartB(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const deliveryId = str(formData, "transaction_id");
  const vehicleRegistrationNo = str(formData, "vehicle_registration_no").toUpperCase();
  const driverName = str(formData, "driver_name");
  const driverNric = str(formData, "driver_nric");
  const sealNumber = str(formData, "seal_number");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");
  const result = str(formData, "result") === "ESCALATE" ? "ESCALATE" : "PASS";
  const escalationReason = str(formData, "escalation_reason");

  if (!deliveryId) return { error: "Missing delivery reference." };
  if (!vehicleRegistrationNo || !driverName || !driverNric || !sealNumber) {
    return { error: "Vehicle registration, driver name, NRIC and seal number are all required." };
  }
  if (!signature) return { error: "Signature is required." };
  if (result === "ESCALATE" && !escalationReason) return { error: "An escalation reason is required." };

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "vendor-part-b");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await callCaterlinkRpc(supabase, "record_caterlink_vendor_security_check_secure", {
    p_delivery_id: deliveryId,
    p_signature_url: sig.path,
    p_signature_hash: sig.sha256,
    p_result: result,
    p_remarks: remarks || undefined,
    p_escalation_reason: escalationReason || undefined,
    p_observed: {
      vehicle_registration_no: vehicleRegistrationNo,
      driver_name: driverName,
      driver_nric: driverNric,
      seal_number: sealNumber,
    },
  });
  if (error) {
    return { error: `The security check could not be saved: ${rpcMessage(error)}` };
  }

  revalidatePath(`/icms/vendor-transactions/${deliveryId}`);
  revalidatePath("/icms/vendor-transactions");
  redirect(`/icms/vendor-transactions/${deliveryId}?approved=1`);
}

/**
 * Part C: the owning Vendor confirms the completed handover after the security check passed.
 * (The legacy dual warehouse-PIC signature is not part of the canonical model; see
 * docs/dashboard-review/caterlink-legacy-to-canonical-mapping.md.)
 */
export async function submitVendorPartC(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireRole(["vendor"]);

  const deliveryId = str(formData, "transaction_id");
  const signature = str(formData, "vendor_signature");
  if (!deliveryId) return { error: "Missing delivery reference." };
  if (!signature) return { error: "The Vendor Driver signature is required." };

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "vendor-part-c");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await callCaterlinkRpc(supabase, "complete_caterlink_vendor_delivery_secure", {
    p_delivery_id: deliveryId,
    p_signature_url: sig.path,
    p_signature_hash: sig.sha256,
  });
  if (error) {
    return { error: `The delivery could not be completed: ${rpcMessage(error)}` };
  }

  revalidatePath(`/icms/vendor-transactions/${deliveryId}`);
  revalidatePath("/icms/vendor-transactions");
  redirect(`/icms/vendor-transactions/${deliveryId}?completed=1`);
}
