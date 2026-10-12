import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { Profile } from "@/lib/avsec/types";
import { createClient } from "@/lib/supabase/server";
import type { ReportFormType } from "@/lib/auth/role-capabilities";

/**
 * THE report-form capability resolver. Which forms a person may CREATE is data: public.report_form_assignments (role, optional station,
 * optional person), seeded explicitly for the operational defaults and documented in docs/dashboard-review/role-workspace-correction.md.
 * Pages, the "new report" list and every submit action ask the database (can_create_report_form / list_my_report_forms_secure), and a
 * BEFORE INSERT trigger on every report table enforces the same rule, so a hidden link is never the control.
 */
export async function getAllowedReportForms(): Promise<ReportFormType[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_report_forms_secure");
  if (error || !data) return [];
  return data.map((r) => r.form_type as ReportFormType);
}

export async function mayCreateReportForm(type: ReportFormType): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("can_create_report_form", { p_form: type });
  return !error && data === true;
}

/** Page guard: an approved profile with an active assignment whose function includes this form; everyone else goes to their dashboard. */
export async function requireReportFormAccess(type: ReportFormType): Promise<Profile> {
  const profile = await requireProfile();
  if (!(await mayCreateReportForm(type))) redirect("/avsec/my-dashboard");
  return profile;
}
