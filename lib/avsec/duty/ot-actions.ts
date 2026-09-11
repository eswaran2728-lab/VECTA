"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/avsec/auth";

export interface OtRequestRow {
  id: string;
  org_id: string;
  requester_id: string;
  requester_name?: string;
  requester_staff_no?: string;
  branch: "operation_avsec" | "ifc_avsec" | "hub_avsec";
  work_date: string;
  hours: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  reviewed_by: string | null;
  reviewed_by_name?: string | null;
  reviewed_at: string | null;
  notes: string | null;
  created_at: string;
}

export async function submitOtRequest(formData: FormData) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return { error: "You must be signed in to submit an OT request." };
  }

  if (profile.role !== "ASO") {
    return { error: "Only ASO staff can submit OT requests." };
  }

  if (!profile.ops_group) {
    return { error: "Your profile has no assigned branch / ops group." };
  }

  const workDate = String(formData.get("workDate") || "").trim();
  const hours = parseFloat(String(formData.get("hours") || "0"));
  const reason = String(formData.get("reason") || "").trim();

  if (!workDate) {
    return { error: "Please select a date for the OT request." };
  }

  if (isNaN(hours) || hours <= 0 || hours > 24) {
    return { error: "Please enter valid OT hours (between 0.5 and 24 hours)." };
  }

  if (!reason || reason.length < 5) {
    return { error: "Please provide a detailed reason for the overtime." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ot_requests")
    .insert({
      requester_id: profile.id,
      branch: profile.ops_group,
      work_date: workDate,
      hours,
      reason,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    console.error("Error submitting OT request:", error);
    return { error: error.message };
  }

  revalidatePath("/avsec/duty/ot");
  return { success: true, request: data };
}

export async function reviewOtRequest(
  requestId: string,
  status: "approved" | "rejected",
  notes?: string
) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return { error: "You must be signed in." };
  }

  if (profile.role !== "DSE" && profile.role !== "MANAGEMENT" && profile.role !== "ADMIN") {
    return { error: "Only DSE or Management can review OT requests." };
  }

  const supabase = await createClient();

  // Fetch the request to verify branch matching for DSE
  const { data: otReq } = await supabase
    .from("ot_requests")
    .select("branch")
    .eq("id", requestId)
    .maybeSingle();

  if (!otReq) {
    return { error: "OT request not found." };
  }

  if (profile.role === "DSE" && otReq.branch !== profile.ops_group) {
    return { error: "You can only review OT requests from your own branch." };
  }

  const { error } = await supabase
    .from("ot_requests")
    .update({
      status,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
      notes: notes?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId);

  if (error) {
    console.error("Error reviewing OT request:", error);
    return { error: error.message };
  }

  revalidatePath("/avsec/duty/ot");
  return { success: true };
}

export async function getOtRequests(): Promise<OtRequestRow[]> {
  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();
  let query = supabase
    .from("ot_requests")
    .select(`
      *,
      requester:profiles!ot_requests_requester_id_fkey(name, staff_no),
      reviewer:profiles!ot_requests_reviewed_by_fkey(name)
    `)
    .order("created_at", { ascending: false });

  if (profile.role === "ASO") {
    query = query.eq("requester_id", profile.id);
  } else if (profile.role === "DSE" && profile.ops_group) {
    query = query.eq("branch", profile.ops_group);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Error fetching OT requests:", error);
    return [];
  }

  return ((data as unknown as Array<Record<string, unknown>>) ?? []).map((row) => {
    const requester = row.requester as { name?: string; staff_no?: string } | null;
    const reviewer = row.reviewer as { name?: string } | null;
    return {
      ...(row as unknown as OtRequestRow),
      requester_name: requester?.name,
      requester_staff_no: requester?.staff_no,
      reviewed_by_name: reviewer?.name,
    };
  });
}
