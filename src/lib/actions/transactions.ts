"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile, requireRole } from "@/lib/auth";
import { uploadDataUrl } from "@/lib/storage";
import type { DeliveryLocation, Direction } from "@/lib/database.types";

export interface ActionState {
  error: string | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

/**
 * Part A: Warehouse PIC creates the transaction + Part A record together.
 * DB trigger assigns the CSCS-YYYY-NNNNNN number; audit triggers log both writes.
 */
export async function createTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["warehouse_pic"]);

  const direction = str(formData, "direction") as Direction;
  const vehicleNumber = str(formData, "vehicle_number");
  const driverName = str(formData, "driver_name");
  const driverId = str(formData, "driver_id");
  const sealNumber = str(formData, "seal_number");
  const remarks = str(formData, "remarks");
  const vehicleSearchCompleted = bool(formData, "vehicle_search_completed");
  const signature = str(formData, "signature");

  if (!["WAREHOUSE_TO_AIRCRAFT", "AIRCRAFT_TO_WAREHOUSE"].includes(direction)) {
    return { error: "Select a valid direction." };
  }
  if (!vehicleNumber || !driverName || !driverId || !sealNumber) {
    return { error: "Vehicle, driver, driver ID and seal number are all required." };
  }
  if (!vehicleSearchCompleted) {
    return { error: "Vehicle search must be completed before dispatch." };
  }
  if (!signature) {
    return { error: "Signature is required." };
  }

  let signaturePath: string;
  try {
    signaturePath = await uploadDataUrl("signatures", signature, "part-a");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();

  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .insert({
      direction,
      vehicle_number: vehicleNumber.toUpperCase(),
      driver_name: driverName,
      driver_id: driverId,
      seal_number: sealNumber,
      created_by: profile.id,
    })
    .select()
    .single();

  if (txError || !tx) {
    return { error: `Could not create transaction: ${txError?.message ?? "unknown error"}` };
  }

  const { error: partError } = await supabase.from("part_a").insert({
    transaction_id: tx.id,
    pic_name: profile.name,
    pic_staff_id: profile.staff_id,
    vehicle_search_completed: vehicleSearchCompleted,
    signature_url: signaturePath,
    remarks: remarks || null,
    completed_by: profile.id,
  });

  if (partError) {
    return { error: `Part A could not be saved: ${partError.message}` };
  }

  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${tx.id}?created=1`);
}

/** Part B (Post 2) and Part C (Post 6) share the same shape. */
async function completeChecklistPart(
  part: "part_b" | "part_c",
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole([part === "part_b" ? "post2_avsec" : "post6_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const vehicleVerified = bool(formData, "vehicle_verified");
  const driverVerified = bool(formData, "driver_verified");
  const sealVerified = bool(formData, "seal_verified");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!vehicleVerified || !driverVerified || !sealVerified) {
    return {
      error:
        "All checks must pass. If a check fails, use Report Incident instead of approving.",
    };
  }
  if (!signature) return { error: "Signature is required." };

  let signaturePath: string;
  try {
    signaturePath = await uploadDataUrl("signatures", signature, part.replace("_", "-"));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from(part).insert({
    transaction_id: transactionId,
    avsec_name: profile.name,
    avsec_staff_id: profile.staff_id,
    vehicle_verified: vehicleVerified,
    driver_verified: driverVerified,
    seal_verified: sealVerified,
    signature_url: signaturePath,
    remarks: remarks || null,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Checkpoint could not be saved: ${error.message}` };
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?approved=1`);
}

export async function completePartB(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_b", formData);
}

export async function completePartC(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_c", formData);
}

/** Part D: final delivery confirmation; DB trigger sets COMPLETED. */
export async function completePartD(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["receiver"]);

  const transactionId = str(formData, "transaction_id");
  const deliveryLocation = str(formData, "delivery_location") as DeliveryLocation;
  const sealIntact = bool(formData, "seal_intact");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!["SRA_WAREHOUSE", "AIRCRAFT"].includes(deliveryLocation)) {
    return { error: "Select the delivery location." };
  }
  if (!sealIntact) {
    return {
      error: "Seal must be intact to complete delivery. If broken, use Report Incident.",
    };
  }
  if (!signature) return { error: "Signature is required." };

  let signaturePath: string;
  try {
    signaturePath = await uploadDataUrl("signatures", signature, "part-d");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("part_d").insert({
    transaction_id: transactionId,
    delivery_location: deliveryLocation,
    receiver_name: profile.name,
    receiver_staff_id: profile.staff_id,
    seal_intact: sealIntact,
    signature_url: signaturePath,
    remarks: remarks || null,
    completed_by: profile.id,
  });

  if (error) {
    return { error: `Delivery could not be saved: ${error.message}` };
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?completed=1`);
}

/** Incident report from any signed-in role; DB trigger escalates the transaction. */
export async function reportIncident(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireProfile();

  const transactionId = str(formData, "transaction_id");
  const incidentType = str(formData, "incident_type");
  const description = str(formData, "description");
  const photo = str(formData, "photo");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (
    !["BROKEN_SEAL", "SEAL_MISMATCH", "UNAUTHORIZED_DRIVER", "UNAUTHORIZED_VEHICLE", "OTHER"].includes(
      incidentType
    )
  ) {
    return { error: "Select the incident type." };
  }
  if (!description) return { error: "Describe what happened." };

  let photoPath: string | null = null;
  if (photo) {
    try {
      photoPath = await uploadDataUrl("incident-photos", photo, "incident");
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Photo upload failed." };
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.from("incidents").insert({
    transaction_id: transactionId,
    incident_type: incidentType as never,
    description,
    reported_by: `${profile.name} (${profile.staff_id})`,
    reported_by_id: profile.id,
    photo_url: photoPath,
  });

  if (error) {
    return { error: `Incident could not be saved: ${error.message}` };
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/incidents");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?escalated=1`);
}
