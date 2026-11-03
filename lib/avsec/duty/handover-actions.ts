"use server";

import { createClient } from "@/lib/supabase/server";
import { requireAttendanceProfile } from "@/lib/avsec/auth";
import { handoverSchema } from "@/lib/avsec/schemas/handover";
import { getUnfinishedWorkSummary } from "./handover-queries";

type Fail = { ok: false; error: string };

/* The generated Database types predate these functions; results are narrowed below. */
type RpcResult = { data: any; error: { message?: string } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Client = Awaited<ReturnType<typeof createClient>>;
const rpc = (c: Client, name: string, args: Record<string, unknown>) => (c as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<RpcResult> }).rpc(name, args);

/** The database rejects with a plain sentence; pass it through, never a stack. */
const message = (e: { message?: string } | null | undefined, fallback: string) => e?.message?.trim() || fallback;

/** Resolve a staff ID to ONE eligible receiving officer so the sender can see the name before filing. */
export async function lookupHandoverRecipient(staffNo: string): Promise<{ ok: true; name: string } | Fail> {
  await requireAttendanceProfile();
  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "resolve_handover_recipient_secure", { p_staff_no: String(staffNo ?? "") });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { ok: false, error: message(error, "No unique active officer with that staff ID at your station.") };
  return { ok: true, name: String(row.display_name) };
}

/** The outgoing officer is the signed-in user; station and team are derived in the database, never taken from the client. */
export async function createHandover(input: unknown): Promise<{ ok: true; id: string } | Fail> {
  const profile = await requireAttendanceProfile();
  const parsed = handoverSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  if (!profile.station) return { ok: false, error: "Your profile has no station set — cannot file a handover." };

  const unfinished = await getUnfinishedWorkSummary(profile.station, profile.team ?? undefined);
  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "file_handover_secure", {
    p_recipient_staff_no: v.recipient_staff_id,
    p_place_category: v.place_category,
    p_place_detail: v.place_detail,
    p_flight_number: v.flight_number || "",
    p_handover_notes: v.handover_notes,
    p_unfinished: JSON.parse(JSON.stringify(unfinished)),
  });
  if (error || !data) return { ok: false, error: message(error, "Failed to create handover") };
  return { ok: true, id: String(data) };
}

export async function issueHandoverChallenge(handoverId: string): Promise<{ ok: true; payload: string; expiresAt: string; ttlSeconds: number } | Fail> {
  await requireAttendanceProfile();
  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "issue_handover_challenge_secure", { p_handover_id: handoverId });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { ok: false, error: message(error, "Could not create a QR code.") };
  return { ok: true, payload: `VECTA-HO:${handoverId}:${row.token}`, expiresAt: String(row.expires_at), ttlSeconds: Number(row.ttl_seconds) };
}

export async function pushHandoverSenderLocation(handoverId: string, lat: number, lng: number, accuracyM: number): Promise<{ ok: true } | Fail> {
  await requireAttendanceProfile();
  const supabase = await createClient();
  const { error } = await rpc(supabase, "submit_handover_sender_location_secure", { p_handover_id: handoverId, p_lat: lat, p_lng: lng, p_accuracy_m: accuracyM });
  return error ? { ok: false, error: message(error, "Could not record your location.") } : { ok: true };
}

export type CompleteHandoverOutcome = { ok: true; distanceM: number | null } | { ok: false; code: string; error: string };

/** Called by the recipient after scanning. Expected refusals come back as a code + sentence and leave the handover pending. */
export async function completeHandover(
  handoverId: string,
  token: string,
  fix: { lat: number; lng: number; accuracyM: number; capturedAt: string },
  notes?: string,
): Promise<CompleteHandoverOutcome> {
  await requireAttendanceProfile();
  const supabase = await createClient();
  const { data, error } = await rpc(supabase, "complete_handover_secure", {
    p_handover_id: handoverId,
    p_token: token,
    p_lat: fix.lat,
    p_lng: fix.lng,
    p_accuracy_m: fix.accuracyM,
    p_captured_at: fix.capturedAt,
    p_notes: notes?.trim() || null,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { ok: false, code: "ERROR", error: message(error, "Could not complete the handover.") };
  if (!row.ok) return { ok: false, code: String(row.code), error: String(row.message) };
  return { ok: true, distanceM: row.distance_m == null ? null : Number(row.distance_m) };
}

/** Legacy path: only HISTORICAL (pre-verification) handovers can still be acknowledged this way; the database enforces it. */
export async function acknowledgeHandover(handoverId: string, notes: string): Promise<{ ok: true } | Fail> {
  const profile = await requireAttendanceProfile();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shift_handovers")
    .update({ acknowledged_by: profile.id, acknowledged_at: new Date().toISOString(), acknowledgment_notes: notes || null })
    .eq("id", handoverId)
    .filter("handover_status", "eq", "historical")
    .is("acknowledged_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "This handover cannot be acknowledged this way." };
  return { ok: true };
}
