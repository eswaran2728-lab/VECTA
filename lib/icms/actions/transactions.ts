"use server";

import { partBHoldMessage } from "@/lib/icms/checkpoint-hold-messages";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireCheckpointRole } from "@/lib/icms/auth";
import { uploadDataUrl } from "@/lib/icms/storage";
import { callCaterlinkRpc } from "@/lib/caterlink/vendor";
import { CARGO_TYPES, isHubDestination } from "@/lib/icms/constants";
import type {
  CargoType,
  Direction,
  HubDestination,
  SealColor,
  SealType,
  TransactionRoute,
} from "@/lib/icms/database.types";

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

export interface ActionState {
  error: string | null;
}

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

/** Non-negative integer, or null when the field was left blank. */
function optionalInt(formData: FormData, key: string): number | null {
  const raw = str(formData, key);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * Part A: a PIC creates the transaction + Part A record together.
 * The PIC picks the direction in the form (Step 1); it is no longer
 * implied by the role.
 * DB trigger assigns the ICMS-YYYY-NNNNNN number; audit triggers log both writes.
 */
export async function createTransaction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const profile = await requireRole(["warehouse_pic"]);

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
  const escortVehicleNumber = str(formData, "escort_vehicle_number").toUpperCase();

  // Route (AIRCRAFT/HUB/REDQ) and hub destination — chosen via the flat
  // Inbound/Outbound/Hub/REDQ→FOB selector on the form. Hub and REDQ imply
  // direction OUTBOUND (never asked separately); the form already enforces
  // this, re-validated here since this is the real check.
  const route = (str(formData, "route") || "AIRCRAFT") as TransactionRoute;
  const hubDestination = (str(formData, "hub_destination") || null) as HubDestination | null;

  // IFCSF (AA/SEC/F/010 Rev.01) header + Part A supplies breakdown.
  const station = str(formData, "station").toUpperCase();
  const cargoTypes = formData.getAll("cargo_types").map(String) as CargoType[];
  const suppliesTotal = optionalInt(formData, "supplies_total");
  const suppliesCarts = optionalInt(formData, "supplies_carts");
  const suppliesSmu = optionalInt(formData, "supplies_smu");
  const suppliesPallets = optionalInt(formData, "supplies_pallets");
  const suppliesBoxes = optionalInt(formData, "supplies_boxes");
  const suppliesOvenRacks = optionalInt(formData, "supplies_oven_racks");

  // The warehouse PIC chooses the direction at creation (Outbound dispatch
  // or Inbound return). Downstream checkpoint order is direction-aware.
  if (direction !== "OUTBOUND" && direction !== "INBOUND") {
    return {
      error: "Select a direction (Outbound or Inbound). / Pilih arah (Keluar atau Masuk).",
    };
  }
  if (!["AIRCRAFT", "HUB", "REDQ"].includes(route)) {
    return { error: "Invalid route selected." };
  }
  if ((route === "HUB" || route === "REDQ") && direction !== "OUTBOUND") {
    return {
      error:
        "Hub and REDQ → FOB are outbound-only routes. / Hub dan REDQ → FOB adalah laluan keluar sahaja.",
    };
  }
  if (route === "HUB" && !hubDestination) {
    return { error: "Select a hub destination. / Pilih destinasi hab." };
  }
  if (route === "HUB" && !isHubDestination(hubDestination)) {
    return { error: "Invalid hub destination selected." };
  }
  if (route !== "HUB" && hubDestination) {
    return { error: "Hub destination only applies to the Hub route." };
  }
  if (!vehicleNumber || !driverName || !driverId) {
    return { error: "Vehicle, driver and driver ID are all required." };
  }
  if (!station) {
    return { error: "Station is required. / Stesen diperlukan." };
  }
  if (cargoTypes.length === 0 || !cargoTypes.every((c) => CARGO_TYPES.includes(c))) {
    return {
      error: "Select at least one cargo type. / Pilih sekurang-kurangnya satu jenis kargo.",
    };
  }

  // GSE Workshop maintenance is auto-derived, never chosen directly: the
  // workshop has no security checkpoint and maintenance duration is
  // unknown up front, so a plain Outbound movement tagged "Vehicle
  // Maintenance" completes at Part C instead of waiting on a Part D that
  // can never happen. Hub/REDQ already have their own terminal step, so
  // this only overrides the default AIRCRAFT route.
  const effectiveRoute: TransactionRoute =
    route === "AIRCRAFT" && direction === "OUTBOUND" && cargoTypes.includes("VEHICLE_MAINTENANCE")
      ? "MAINTENANCE"
      : route;
  if (!seals) {
    return { error: "Add at least one seal with a number, type and color." };
  }
  if (new Set(seals.map((s) => s.seal_number)).size !== seals.length) {
    return { error: "Duplicate seal numbers — each seal number must be unique." };
  }
  const truckSeals = seals.filter((s) => s.seal_type === "TRUCK_SEAL");
  if (truckSeals.length === 0) {
    return { error: "A truck seal is required. / Sil trak diperlukan." };
  }
  // Seal colour is a manual, per-seal choice (parseSealDrafts already
  // rejects any seal without a color picked) — no direction-based rule.
  if (!vehicleSearchCompleted) {
    return { error: "Vehicle search must be completed before dispatch." };
  }
  if (!signature) {
    return { error: "Signature is required." };
  }
  // Escort officer name / staff ID / escort vehicle number are all-or-nothing.
  const escortFields = [escortName, escortStaffId, escortVehicleNumber].filter(Boolean);
  if (escortFields.length > 0 && escortFields.length < 3) {
    return {
      error:
        "Escort officer name, staff ID and escort vehicle number must all be filled in together, or all left blank. " +
        "/ Nama pegawai pengiring, ID kakitangan dan nombor kenderaan pengiring mesti diisi bersama, atau dibiarkan kosong semua.",
    };
  }

  // Canonical Phase 9 path: the database (create_caterlink_driver_transaction_secure) decides who may
  // create, resolves the whitelist entries against the station's AOC (an unlisted, expired, revoked or
  // not-yet-effective vehicle/driver is a hard block), checks the whitelisted driver name, numbers the
  // movement, records the seal and Part A atomically, and audits it. Nothing below trusts a client
  // identity: the PIC's name and staff id come from the trusted account row inside the function.
  const truckSeal = seals.find((s) => s.seal_type === "TRUCK_SEAL");
  if (!truckSeal) {
    return { error: "A truck seal is required. / Sil trak diperlukan." };
  }

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-a");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  // Fields the canonical transaction row has no column for are kept with Part A as a remark so they are
  // not lost (escort details, supplies breakdown, additional seals).
  const extra: string[] = [];
  if (escortName) extra.push(`Escort: ${escortName} (${escortStaffId}), vehicle ${escortVehicleNumber}`);
  const supplies = [
    ["total", suppliesTotal], ["carts", suppliesCarts], ["SMU", suppliesSmu],
    ["pallets", suppliesPallets], ["boxes", suppliesBoxes], ["oven racks", suppliesOvenRacks],
  ].filter(([, n]) => n !== null).map(([k, n]) => `${k} ${n}`);
  if (supplies.length > 0) extra.push(`Supplies: ${supplies.join(", ")}`);
  const otherSeals = seals.filter((s) => s !== truckSeal);
  if (otherSeals.length > 0) extra.push(`Other seals: ${otherSeals.map((s) => `${s.seal_number} (${s.seal_type})`).join(", ")}`);
  const partARemarks = [remarks, ...extra].filter(Boolean).join(" | ");

  const supabase = await createClient();
  const { data, error } = await callCaterlinkRpc(supabase, "create_caterlink_driver_transaction_secure", {
    p_origin_station: station,
    p_direction: direction,
    p_route: effectiveRoute,
    p_vehicle_number: vehicleNumber,
    p_driver_name: driverName,
    p_driver_id: driverId,
    p_seal_number: truckSeal.seal_number,
    p_signature_url: sig.path,
    p_signature_hash: sig.sha256,
    p_vehicle_search_completed: vehicleSearchCompleted,
    p_remarks: partARemarks || undefined,
    p_hub_destination: hubDestination ?? undefined,
    p_flight_number: flightNumber || undefined,
    p_aircraft_reg: aircraftRegistration || undefined,
    p_trolley_count: trolleyCount,
    p_cargo_types: cargoTypes,
  });
  const created = Array.isArray(data) ? data[0] : data;
  if (error || !created?.transaction_id) {
    return {
      error: `Could not create the transaction: ${(error?.message ?? "unknown error").replace(/^ERROR:\s*/i, "")}`,
    };
  }

  revalidatePath("/icms/transactions");
  revalidatePath("/icms/dashboard");
  redirect(`/icms/transactions/${created.transaction_id}?created=1`);
}

/**
 * Part B (In-flight Security Post). The ONLY write path is record_caterlink_part_b_secure(): it derives the actor from the session,
 * authorises the station / capability / duty, validates the workflow state, verifies seals and the observed whitelist, records the
 * checkpoint, advances (or freezes) the transaction, audits and notifies -- atomically. This action only validates the shape of the
 * input, uploads the signature and maps the result to a safe message. The officer's identity, date and time are never taken from the form.
 */
export async function completePartB(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireCheckpointRole("post2_avsec");

  const transactionId = str(formData, "transaction_id");
  const result = str(formData, "result");
  const escalationReason = str(formData, "escalation_reason");
  const signature = str(formData, "signature");
  const observedVehicle = str(formData, "observed_vehicle_number");
  const observedDriverName = str(formData, "observed_driver_name");
  const observedDriverId = str(formData, "observed_driver_id");
  let sealEntries: unknown;
  let sealColors: unknown;
  try {
    sealEntries = JSON.parse(str(formData, "seal_entries") || "{}");
    sealColors = JSON.parse(str(formData, "seal_colors") || "{}");
  } catch {
    return { error: "Seal entries missing. Enter every seal number and colour. / Masukkan setiap nombor dan warna sil." };
  }

  if (!transactionId) return { error: "Missing transaction reference." };
  if (!observedVehicle || !observedDriverName || !observedDriverId) return { error: "Vehicle and driver details are required." };
  if (result !== "PASS" && result !== "ESCALATE") return { error: "Select Pass or Escalate." };
  if (result === "ESCALATE" && !escalationReason) return { error: "An escalation reason is required." };
  if (result === "PASS" && (!bool(formData, "vehicle_verified") || !bool(formData, "driver_verified"))) {
    return { error: "Vehicle and driver checks must pass. If a check fails, choose Escalate instead of approving." };
  }
  if (!signature) return { error: "Signature is required." };

  let sig: { path: string; sha256: string };
  try {
    sig = await uploadDataUrl("signatures", signature, "part-b");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Signature upload failed." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_caterlink_part_b_secure", {
    p_transaction_id: transactionId,
    p_vehicle_verified: bool(formData, "vehicle_verified"),
    p_driver_verified: bool(formData, "driver_verified"),
    p_seal_entries: sealEntries as never,
    p_seal_colors: sealColors as never,
    p_observed_vehicle: observedVehicle,
    p_observed_driver_name: observedDriverName,
    p_observed_driver_id: observedDriverId,
    p_signature_url: sig.path,
    p_signature_hash: sig.sha256,
    p_remarks: str(formData, "remarks"),
    p_result: result,
    p_escalation_reason: escalationReason,
  });
  if (error) {
    // The function's own messages are written for the officer (uniform for authorization failures); anything that looks like
    // a database internal (constraint, relation, permission, syntax) is replaced by a generic message.
    const internal = /violates|constraint|relation|column|syntax|permission denied|function|schema|duplicate key/i.test(error.message);
    return { error: internal ? "The checkpoint could not be recorded." : error.message.slice(0, 200) };
  }
  const row = data?.[0];
  if (!row) return { error: "The checkpoint could not be recorded." };

  revalidatePath(`/icms/transactions/${transactionId}`);
  revalidatePath("/icms/transactions");
  revalidatePath("/icms/dashboard");
  // an automatic escalation freezes the movement: the form is gone on the next render, so the officer is sent to the transaction page,
  // which shows the hold instruction for this (whitelisted) outcome code
  if (partBHoldMessage(row.outcome)) redirect(`/icms/transactions/${transactionId}?escalated=1&hold=${row.outcome}`);
  if (row.outcome === "ESCALATED") redirect(`/icms/transactions/${transactionId}?escalated=1`);
  redirect(`/icms/transactions/${transactionId}?${row.outcome === "COMPLETED" ? "completed" : "approved"}=1`);
}

// Parts C, D, Hub, REDQ, Skip and the general incident report have no canonical write path yet (they await the process owner's answers); their
// legacy server actions, which wrote to tables that do not exist on this environment, were removed. See
// docs/dashboard-review/caterlink-workflow-gap-audit.md.
