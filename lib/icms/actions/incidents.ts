"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { callCaterlinkRpc } from "@/lib/caterlink/vendor";

export interface ResolveState {
  error: string | null;
  success: string | null;
}

/**
 * CaterLink Management resolves an incident through the authorised audited RPC
 * (resolve_caterlink_incident_secure). Resolution notes are mandatory; the database decides who may.
 */
export async function resolveIncident(
  _prev: ResolveState,
  formData: FormData
): Promise<ResolveState> {
  await requireRole(["supervisor", "enforcement", "management"]);

  const incidentId = String(formData.get("incident_id") ?? "");
  const notes = String(formData.get("resolution_notes") ?? "").trim();

  if (!incidentId) return { error: "Invalid resolution request.", success: null };
  if (!notes) return { error: "Resolution notes are mandatory to resolve an incident.", success: null };

  const supabase = await createClient();
  const { error } = await callCaterlinkRpc(supabase, "resolve_caterlink_incident_secure", {
    p_incident_id: incidentId,
    p_resolution_notes: notes,
  });
  if (error) return { error: error.message.replace(/^ERROR:\s*/i, ""), success: null };

  revalidatePath("/icms/incidents");
  return { error: null, success: "Incident resolved." };
}

/**
 * Reopens a resolved or closed incident through the authorized audited RPC.
 */
export async function reopenIncident(
  _prev: ResolveState,
  formData: FormData
): Promise<ResolveState> {
  await requireRole(["supervisor", "enforcement", "management"]);

  const incidentId = String(formData.get("incident_id") ?? "");
  const reason = String(formData.get("reopen_reason") ?? "").trim();

  if (!incidentId || !reason) {
    return { error: "Incident ID and reopen reason are required.", success: null };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("reopen_caterlink_incident_secure", {
    p_incident_id: incidentId,
    p_reopen_reason: reason,
  });

  if (error) return { error: error.message, success: null };

  revalidatePath("/icms/incidents");
  return { error: null, success: "Incident successfully reopened." };
}
