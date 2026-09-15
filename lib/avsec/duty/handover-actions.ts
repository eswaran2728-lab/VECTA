"use server";

import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/avsec/auth";
import { handoverSchema } from "@/lib/avsec/schemas/handover";
import { getUnfinishedWorkSummary } from "./handover-queries";

export async function createHandover(
  input: unknown,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const profile = await requireProfile();
  const parsed = handoverSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const v = parsed.data;

  const station = profile.station ?? "";
  if (!station) {
    return { ok: false, error: "Your profile has no station set — cannot file a handover." };
  }

  const unfinishedWork = await getUnfinishedWorkSummary(station, v.team);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("shift_handovers")
    .insert({
      outgoing_profile_id: profile.id,
      station,
      team: v.team,
      ops_group: profile.ops_group ?? null,
      staff_name: v.staff_name,
      staff_id: v.staff_id,
      place_category: v.place_category,
      place_detail: v.place_detail,
      flight_number: v.flight_number || null,
      handover_notes: v.handover_notes,
      unfinished_work_summary: JSON.parse(JSON.stringify(unfinishedWork)),
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Failed to create handover" };
  }
  return { ok: true, id: data.id };
}

export async function acknowledgeHandover(
  handoverId: string,
  notes: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const profile = await requireProfile();
  const supabase = await createClient();

  const { error } = await supabase
    .from("shift_handovers")
    .update({
      acknowledged_by: profile.id,
      acknowledged_at: new Date().toISOString(),
      acknowledgment_notes: notes || null,
    })
    .eq("id", handoverId)
    .is("acknowledged_at", null);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
