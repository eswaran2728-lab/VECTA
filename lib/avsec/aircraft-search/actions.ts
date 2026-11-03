"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAttendanceProfile } from "@/lib/avsec/auth";

type Rpc = (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpcOf = async (): Promise<Rpc> => {
  const c = (await createClient()) as unknown as { rpc: Rpc };
  return (n, a) => c.rpc(n, a);
};
const message = (e: { message?: string } | null, fallback: string) => e?.message?.trim() || fallback;
const first = <T,>(d: unknown): T | null => (Array.isArray(d) ? (d[0] as T) : (d as T)) ?? null;

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
}

/** Records the START of the physical search with SERVER time and the device's reported location (or a reason when location is unavailable). */
export async function startAircraftSearch(input: { flight: string; registration: string; station: string; aircraftType: string; fix: Fix | null; unavailableReason?: string }): Promise<{ ok: true; recordId: string } | { ok: false; error: string }> {
  await requireAttendanceProfile();
  const rpc = await rpcOf();
  const { data, error } = await rpc("start_aircraft_search_secure", {
    p_flight: input.flight,
    p_registration: input.registration,
    p_station: input.station,
    p_aircraft_type: input.aircraftType,
    p_lat: input.fix?.lat ?? null,
    p_lng: input.fix?.lng ?? null,
    p_accuracy_m: input.fix?.accuracyM ?? null,
    p_unavailable_reason: input.unavailableReason ?? null,
  });
  if (error || !data) return { ok: false, error: message(error, "Could not start the search record.") };
  return { ok: true, recordId: String(data) };
}

export async function finishAircraftSearch(input: { recordId: string; fix: Fix | null; unavailableReason?: string }): Promise<{ ok: true; minutes: number; belowMinimum: boolean; minimum: number | null; presence: string } | { ok: false; error: string }> {
  await requireAttendanceProfile();
  const rpc = await rpcOf();
  const { data, error } = await rpc("finish_aircraft_search_secure", {
    p_record_id: input.recordId,
    p_lat: input.fix?.lat ?? null,
    p_lng: input.fix?.lng ?? null,
    p_accuracy_m: input.fix?.accuracyM ?? null,
    p_unavailable_reason: input.unavailableReason ?? null,
  });
  const row = first<{ duration_minutes: number | string; below_minimum: boolean; minimum_minutes: number | null; presence_status: string }>(data);
  if (error || !row) return { ok: false, error: message(error, "Could not finish the search record.") };
  return { ok: true, minutes: Number(row.duration_minutes), belowMinimum: row.below_minimum, minimum: row.minimum_minutes, presence: row.presence_status };
}

export interface DepartureAssessment {
  required: boolean;
  reasons: string[];
  carrier: string;
  threshold_minutes: number;
  linked_record_id: string | null;
  duplicate_ids: string[];
  std_gap_minutes: number | null;
  departure_gap_minutes: number | null;
  std_flag: boolean;
  departure_flag: boolean;
  missing: boolean;
  flagged: boolean;
  error?: string;
}

/** What the departure form shows before submit: requirement, both gaps from SEC029 submission, and whether a reason is needed. */
export async function previewDepartureSearch(input: { station: string; registration: string; flight: string; std: string; aircraftType: string; towed: boolean }): Promise<DepartureAssessment | null> {
  await requireAttendanceProfile();
  if (!input.station || !input.registration.trim() || !input.flight.trim() || !/^\d{2}:\d{2}/.test(input.std)) return null;
  const rpc = await rpcOf();
  const { data, error } = await rpc("preview_departure_search_secure", {
    p_station: input.station,
    p_registration: input.registration.trim().toUpperCase(),
    p_flight: input.flight.trim().toUpperCase(),
    p_sta_std: input.std,
    p_aircraft_type: input.aircraftType,
    p_towed: input.towed,
  });
  if (error || !data) return null;
  return data as DepartureAssessment;
}

export type ReviewOutcome = { ok: true; message: string } | { ok: false; code: string; error: string };

/** One decision per search; the database refuses self-review, anyone involved, off-duty or ineligible reviewers and a second decision. */
export async function reviewAircraftSearch(input: { recordId: string; decision: "confirm" | "exception"; note: string }): Promise<ReviewOutcome> {
  await requireAttendanceProfile();
  const rpc = await rpcOf();
  const { data, error } = await rpc("review_aircraft_search_secure", { p_record_id: input.recordId, p_decision: input.decision, p_note: input.note });
  const row = first<{ ok: boolean; code: string; message: string }>(data);
  if (error || !row) return { ok: false, code: "ERROR", error: message(error, "Could not record the review.") };
  if (!row.ok) return { ok: false, code: row.code, error: row.message };
  revalidatePath("/avsec/aircraft-search");
  revalidatePath("/avsec/bay-board");
  return { ok: true, message: row.message };
}
