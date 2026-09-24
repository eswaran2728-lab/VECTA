import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "./resend";
import { buildReportEmailHtml, type EmailField } from "./reportEmailTemplate";
import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";

/**
 * Emails every ADMIN-role user a copy of a just-submitted report. Best-effort only —
 * any failure (missing API key, network error, no admins configured) is logged and
 * swallowed so it can never affect the report submission itself.
 * Recipient lookup runs on the service-role client: get_admin_emails() is no longer
 * callable by an ordinary authenticated session (2026-09-24), so this is the only
 * path left able to resolve it.
 */
export async function notifyReportSubmission({
  reportType,
  submittedAt,
  submittedByName,
  submittedByStaffNo,
  fields,
}: {
  reportType: ReportType | "offload";
  submittedAt: string;
  submittedByName: string;
  submittedByStaffNo: string;
  fields: EmailField[];
}): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data: adminEmails, error } = await supabase.rpc("get_admin_emails");

    if (error || !adminEmails || adminEmails.length === 0) {
      return;
    }

    const meta = REPORT_META[reportType];
    const html = buildReportEmailHtml({
      reportName: meta.name,
      formCode: meta.code,
      submittedAt,
      submittedByName,
      submittedByStaffNo,
      fields,
    });

    const result = await sendEmail({
      to: adminEmails as string[],
      subject: `${meta.name} submitted by ${submittedByName}`,
      html,
    });

    if (!result.ok) {
      console.error(`[notifyReportSubmission] ${reportType}: ${result.error}`);
    }
  } catch (err) {
    console.error(`[notifyReportSubmission] ${reportType} failed:`, err);
  }
}
