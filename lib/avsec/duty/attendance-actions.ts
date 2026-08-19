"use server";

import { redirect } from "next/navigation";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";

export async function runAttendanceSweep(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const returnTo = String(formData.get("returnTo") || "/admin/attendance-report");
  const supabase = await createClient();
  const { error } = await supabase.rpc("run_attendance_sweep");

  const separator = returnTo.includes("?") ? "&" : "?";
  if (error) {
    redirect(`${returnTo}${separator}error=${encodeURIComponent(error.message)}`);
  }
  redirect(`${returnTo}${separator}swept=1`);
}
