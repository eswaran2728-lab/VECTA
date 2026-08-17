"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { ROLE_RANK } from "@/lib/reference-data";
import { combineDateTimeMY } from "@/lib/datetime";
import { overtimeRequestSchema } from "@/lib/schemas/duty";

function localDateTimeToISO(value: string): string {
  const [date, time] = value.split("T");
  return combineDateTimeMY(date ?? "", (time ?? "").slice(0, 5));
}

export async function submitOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  if (!profile.station) redirect("/duty/overtime/new?error=" + encodeURIComponent("Profile has no station set."));

  const parsed = overtimeRequestSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    redirect("/duty/overtime/new?error=" + encodeURIComponent(parsed.error.issues.map((i) => i.message).join("; ")));
  }
  const v = parsed.data;

  const startAt = localDateTimeToISO(v.start_at);
  const endAt = localDateTimeToISO(v.end_at);
  if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
    redirect("/duty/overtime/new?error=" + encodeURIComponent("End time must be after start time."));
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("overtime_requests")
    .insert({
      profile_id: profile.id,
      station: profile.station,
      team: profile.team || null,
      work_date: v.work_date,
      shift_code: v.shift_code || null,
      start_at: startAt,
      end_at: endAt,
      category: v.category,
      reason: v.reason,
      linked_duty_id: v.linked_duty_id || null,
    })
    .select("id")
    .single();

  if (error || !data) {
    redirect("/duty/overtime/new?error=" + encodeURIComponent(error?.message ?? "Couldn't submit request."));
  }

  revalidatePath("/duty/overtime");
  redirect(`/duty/overtime/${data.id}`);
}

function backTo(id: string) {
  return `/duty/overtime/${id}`;
}

/** SO/DSE/ENFORCEMENT (rank above the submitter, below MANAGEMENT) endorse a pending
 * request. RLS ("overtime settle update") is the actual authorization boundary — this
 * rank check just keeps the wrong-tier action from being attempted in the first place. */
export async function endorseOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  if (ROLE_RANK[profile.role] >= ROLE_RANK.MANAGEMENT) {
    redirect(backTo(id) + "?error=" + encodeURIComponent("Management approves directly — no separate endorsement needed."));
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "endorsed", endorsed_by: profile.id, endorsed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/duty/overtime");
}

export async function approveOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  if (ROLE_RANK[profile.role] < ROLE_RANK.MANAGEMENT) {
    redirect(backTo(id) + "?error=" + encodeURIComponent("Only Management or Admin can give final approval."));
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "approved", approved_by: profile.id, approved_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["pending", "endorsed"]);

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/duty/overtime");
}

export async function rejectOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  const reason = String(formData.get("rejection_reason") || "").trim();
  if (!id) return;
  if (!reason) redirect(backTo(id) + "?error=" + encodeURIComponent("A rejection reason is required."));

  const supabase = createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({
      status: "rejected",
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
      rejection_reason: reason,
    })
    .eq("id", id)
    .in("status", ["pending", "endorsed"]);

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/duty/overtime");
}

/** The claimant can withdraw their own request while it's still untouched — RLS
 * ("overtime own update") only allows this while status = 'pending'. */
export async function withdrawOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  const supabase = createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("profile_id", profile.id)
    .eq("status", "pending");

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/duty/overtime");
}
