"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile, requireRole } from "@/lib/auth";
import { uploadDataUrl } from "@/lib/storage";
import { checkpointOrderError, CREATOR_DIRECTIONS, getStep } from "@/lib/workflow";
import { generateQrToken } from "@/lib/qr-token";
import { DIRECTION_TRUCK_SEAL_COLOR } from "@/lib/constants";
import type {
  DeliveryLocation,
  Direction,
  Seal,
  SealCheckpoint,
  SealColor,
  SealType,
  Transaction,
  UserProfile,
} from "@/lib/database.types";

interface SealDraftInput {
  seal_number: string;
  seal_type: SealType;
  seal_color: SealColor;
}

const SEAL_TYPES: SealType[] = ["TRUCK_SEAL", "TROLLEY", "OTHER"];
const SEAL_COLORS: SealColor[] = ["BLUE", "GREEN", "OTHER"];

function parseSealDrafts(raw: string): SealDraftInput[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const seals: SealDraftInput[] = [];
    for (const item of parsed) {
      const number = String(item?.seal_number ?? "").trim().toUpperCase();
      const type = String(item?.seal_type ?? "") as SealType;
      const color = String(item?.seal_color ?? "") as SealColor;
      if (!number || !SEAL_TYPES.includes(type) || !SEAL_COLORS.includes(color)) return null;
      seals.push({ seal_number: number, seal_type: type, seal_color: color });
    }
    return seals;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.trim().toUpperCase();

/**
 * Verify entered seal numbers against the seals of record, write the
 * verification trail, and auto-escalate via a SEAL_MISMATCH incident when
 * anything does not match. Returns null when all seals matched.
 */
async function verifySealsAtCheckpoint(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: UserProfile,
  transactionId: string,
  checkpoint: SealCheckpoint,
  rawEntries: string
): Promise<string | null> {
  let entries: Record<string, string>;
  try {
    entries = JSON.parse(rawEntries);
  } catch {
    return "Seal entries missing. Enter every seal number. / Masukkan setiap nombor sil.";
  }

  const { data: sealRows, error } = await supabase
    .from("seals")
    .select("*")
    .eq("transaction_id", transactionId);
  if (error || !sealRows || sealRows.length === 0) {
    return "No seals on record for this transaction. / Tiada sil direkodkan untuk transaksi ini.";
  }
  const seals = sealRows as Seal[];

  const mismatches: string[] = [];
  const verifications = seals.map((seal) => {
    const entered = norm(String(entries[seal.id] ?? ""));
    const matched = entered !== "" && entered === norm(seal.seal_number);
    if (!matched) mismatches.push(entered || "(blank)");
    return {
      seal_id: seal.id,
      checkpoint,
      entered_seal_number: entered || "(blank)",
      matched,
      verified_by: profile.id,
      photo_url: null,
    };
  });

  const { error: verError } = await supabase.from("seal_verifications").insert(verifications);
  if (verError) {
    return `Seal verification could not be saved: ${verError.message}`;
  }

  if (mismatches.length > 0) {
    await supabase.from("incidents").insert({
      transaction_id: transactionId,
      incident_type: "SEAL_MISMATCH",
      description:
        `Automatic escalation at ${checkpoint}: entered seal number(s) ${mismatches.join(", ")} ` +
        `did not match the seals applied at Part A. Verified by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    return (
      "SEAL MISMATCH — the transaction has been escalated and the supervisor notified. " +
      "Do not release the vehicle. / KETIDAKPADANAN SIL — transaksi telah dieskalasi dan penyelia dimaklumkan. Jangan lepaskan kenderaan."
    );
  }
  return null;
}

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
 * Part A: a PIC creates the transaction + Part A record together.
 * Direction is bound to the creator's role: warehouse_pic -> OUTBOUND,
 * sra_warehouse_pic -> INBOUND (enforced here AND by RLS).
 * DB trigger assigns the CSCS-YYYY-NNNNNN number; audit triggers log both writes.
 */
export async function createTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["warehouse_pic", "sra_warehouse_pic"]);

  const direction = str(formData, "direction") as Direction;
  const vehicleNumber = str(formData, "vehicle_number").toUpperCase();
  const driverName = str(formData, "driver_name");
  const driverId = str(formData, "driver_id");
  const remarks = str(formData, "remarks");
  const vehicleSearchCompleted = bool(formData, "vehicle_search_completed");
  const signature = str(formData, "signature");
  const seals = parseSealDrafts(str(formData, "seals"));
  const flightNumber = str(formData, "flight_number").toUpperCase();
  const aircraftRegistration = str(formData, "aircraft_registration").toUpperCase();
  const cateringCompanyId = str(formData, "catering_company_id");
  const trolleyCount = Math.max(0, parseInt(str(formData, "trolley_count") || "0", 10) || 0);
  const escortName = str(formData, "escort_officer_name");
  const escortStaffId = str(formData, "escort_officer_staff_id");
  const escalateExpired = bool(formData, "escalate_expired");

  const allowedDirection = CREATOR_DIRECTIONS[profile.role];
  if (direction !== allowedDirection) {
    return {
      error:
        `Your role (${profile.role}) may only create ${allowedDirection} transactions. ` +
        `/ Peranan anda hanya boleh mencipta transaksi ${allowedDirection === "OUTBOUND" ? "keluar" : "masuk"}.`,
    };
  }
  if (!vehicleNumber || !driverName || !driverId) {
    return { error: "Vehicle, driver and driver ID are all required." };
  }
  if (!seals) {
    return { error: "Add at least one seal with a number, type and color." };
  }
  if (new Set(seals.map((s) => s.seal_number)).size !== seals.length) {
    return { error: "Duplicate seal numbers — each seal number must be unique." };
  }
  const requiredColor = DIRECTION_TRUCK_SEAL_COLOR[direction];
  const truckSeals = seals.filter((s) => s.seal_type === "TRUCK_SEAL");
  if (truckSeals.length === 0) {
    return { error: "A truck seal is required. / Sil trak diperlukan." };
  }
  if (truckSeals.some((s) => s.seal_color !== requiredColor)) {
    return {
      error:
        `${direction} truck seals must be ${requiredColor}. ` +
        `/ Sil trak ${direction === "OUTBOUND" ? "keluar mesti BIRU" : "masuk mesti HIJAU"}.`,
    };
  }
  if (!vehicleSearchCompleted) {
    return { error: "Vehicle search must be completed before dispatch." };
  }
  if (!signature) {
    return { error: "Signature is required." };
  }

  const supabase = await createClient();

  // Whitelist checks: matched entries link to the registry; expired passes
  // block (or escalate on explicit confirmation); unlisted entries are
  // allowed only with mandatory remarks and are audit-logged.
  const today = new Date().toISOString().slice(0, 10);
  const [vehicleRes, driverRes] = await Promise.all([
    supabase
      .from("vehicles")
      .select("id, pass_expiry_date, is_active")
      .eq("vehicle_number", vehicleNumber)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("drivers")
      .select("id, pass_expiry_date, is_active")
      .eq("driver_id", driverId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  const vehicleRec = vehicleRes.data;
  const driverRec = driverRes.data;

  const expiredItems: string[] = [];
  if (vehicleRec?.pass_expiry_date && vehicleRec.pass_expiry_date < today) {
    expiredItems.push(`vehicle ${vehicleNumber}`);
  }
  if (driverRec?.pass_expiry_date && driverRec.pass_expiry_date < today) {
    expiredItems.push(`driver ${driverId}`);
  }
  if (expiredItems.length > 0 && !escalateExpired) {
    return {
      error:
        `EXPIRED_PASS: airport pass expired for ${expiredItems.join(" and ")}. ` +
        `The vehicle must not proceed. You may create this record as an Expired Pass incident (escalated to the supervisor) using the button below. ` +
        `/ Pas lapangan terbang telah tamat tempoh.`,
    };
  }

  const unlisted: string[] = [];
  if (!vehicleRec) unlisted.push(`vehicle ${vehicleNumber}`);
  if (!driverRec) unlisted.push(`driver ${driverId}`);
  if (unlisted.length > 0 && !remarks) {
    return {
      error:
        `${unlisted.join(" and ")} not in the whitelist. Remarks are mandatory when proceeding with unlisted entries. ` +
        `/ Tiada dalam senarai putih — catatan wajib diisi.`,
    };
  }

  let signaturePath: string;
  try {
    signaturePath = await uploadDataUrl("signatures", signature, "part-a");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const txId = crypto.randomUUID();
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .insert({
      id: txId,
      direction,
      vehicle_number: vehicleNumber,
      driver_name: driverName,
      driver_id: driverId,
      seal_number: null,
      created_by: profile.id,
      qr_token: generateQrToken(txId),
      flight_number: flightNumber || null,
      aircraft_registration: aircraftRegistration || null,
      catering_company_id: cateringCompanyId || null,
      vehicle_id: vehicleRec?.id ?? null,
      driver_id_ref: driverRec?.id ?? null,
      trolley_count: trolleyCount,
      escort_officer_name: escortName || null,
      escort_officer_staff_id: escortStaffId || null,
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

  const { error: sealsError } = await supabase.from("seals").insert(
    seals.map((s) => ({ ...s, transaction_id: tx.id }))
  );
  if (sealsError) {
    return { error: `Seals could not be saved: ${sealsError.message}` };
  }

  if (expiredItems.length > 0 && escalateExpired) {
    await supabase.from("incidents").insert({
      transaction_id: tx.id,
      incident_type: "EXPIRED_PASS",
      description: `Airport pass expired for ${expiredItems.join(" and ")}. Recorded and escalated at Part A by ${profile.name} (${profile.staff_id}).`,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: null,
    });
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    redirect(`/transactions/${tx.id}?escalated=1`);
  }

  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  redirect(`/transactions/${tx.id}?created=1`);
}

/** Part B (In-flight Post) and Part C (Airport Post) share the same shape.
 * Sequence is direction-aware: see src/lib/workflow.ts. On INBOUND, Part B
 * is the final step and the DB trigger completes the transaction. */
async function completeChecklistPart(
  part: "part_b" | "part_c",
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole([part === "part_b" ? "post2_avsec" : "post6_avsec"]);

  const transactionId = str(formData, "transaction_id");
  const vehicleVerified = bool(formData, "vehicle_verified");
  const driverVerified = bool(formData, "driver_verified");
  const sealEntries = str(formData, "seal_entries");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!vehicleVerified || !driverVerified) {
    return {
      error:
        "Vehicle and driver checks must pass. If a check fails, use Report Incident instead of approving.",
    };
  }
  if (!signature) return { error: "Signature is required." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status">;

  const orderError = checkpointOrderError(tx.direction, part, tx.status);
  if (orderError) return { error: orderError };

  const finalizes = getStep(tx.direction, part)?.finalizes ?? false;

  // Seals must be entered/scanned by number — mismatch auto-escalates.
  const sealError = await verifySealsAtCheckpoint(
    supabaseForCheck,
    profile,
    transactionId,
    part === "part_b" ? "INFLIGHT_POST" : "AIRPORT_POST",
    sealEntries
  );
  if (sealError) {
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath("/dashboard");
    return { error: sealError };
  }

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
    seal_verified: true,
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
  redirect(`/transactions/${transactionId}?${finalizes ? "completed" : "approved"}=1`);
}

export async function completePartB(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_b", formData);
}

export async function completePartC(_prev: ActionState, formData: FormData) {
  return completeChecklistPart("part_c", formData);
}

/** Part D: OUTBOUND-only final delivery confirmation; DB trigger sets COMPLETED. */
export async function completePartD(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["receiver"]);

  const transactionId = str(formData, "transaction_id");
  const deliveryLocation = str(formData, "delivery_location") as DeliveryLocation;
  const sealIntact = bool(formData, "seal_intact");
  const sealEntries = str(formData, "seal_entries");
  const remarks = str(formData, "remarks");
  const signature = str(formData, "signature");

  if (!transactionId) return { error: "Missing transaction reference." };

  const supabaseForCheck = await createClient();
  const { data: txRow } = await supabaseForCheck
    .from("transactions")
    .select("direction, status")
    .eq("id", transactionId)
    .single();

  if (!txRow) return { error: "Transaction not found. / Transaksi tidak dijumpai." };
  const tx = txRow as Pick<Transaction, "direction" | "status">;

  const orderError = checkpointOrderError(tx.direction, "part_d", tx.status);
  if (orderError) return { error: orderError };

  const sealError = await verifySealsAtCheckpoint(
    supabaseForCheck,
    profile,
    transactionId,
    "PART_D",
    sealEntries
  );
  if (sealError) {
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath("/dashboard");
    return { error: sealError };
  }
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

  if (!transactionId) return { error: "Missing transaction reference." };
  if (
    ![
      "BROKEN_SEAL",
      "SEAL_MISMATCH",
      "UNAUTHORIZED_DRIVER",
      "UNAUTHORIZED_VEHICLE",
      "EXPIRED_PASS",
      "WRONG_SEAL_COLOR",
      "OTHER",
    ].includes(incidentType)
  ) {
    return { error: "Select the incident type." };
  }
  if (!description) return { error: "Describe what happened." };

  let photoDataUrls: string[] = [];
  try {
    const parsed = JSON.parse(str(formData, "photos") || "[]");
    if (Array.isArray(parsed)) photoDataUrls = parsed.filter((p) => typeof p === "string");
  } catch {
    // no photos
  }

  const photoPaths: string[] = [];
  for (const dataUrl of photoDataUrls.slice(0, 5)) {
    try {
      photoPaths.push(await uploadDataUrl("incident-photos", dataUrl, "incident"));
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Photo upload failed." };
    }
  }

  const supabase = await createClient();
  const { data: incident, error } = await supabase
    .from("incidents")
    .insert({
      transaction_id: transactionId,
      incident_type: incidentType as never,
      description,
      reported_by: `${profile.name} (${profile.staff_id})`,
      reported_by_id: profile.id,
      photo_url: photoPaths[0] ?? null,
    })
    .select()
    .single();

  if (error || !incident) {
    return { error: `Incident could not be saved: ${error?.message ?? "unknown error"}` };
  }

  if (photoPaths.length > 0) {
    await supabase
      .from("incident_photos")
      .insert(photoPaths.map((p) => ({ incident_id: incident.id, photo_url: p })));
  }

  revalidatePath(`/transactions/${transactionId}`);
  revalidatePath("/incidents");
  revalidatePath("/dashboard");
  redirect(`/transactions/${transactionId}?escalated=1`);
}
