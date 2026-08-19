import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "./resend";
import { buildReportEmailHtml, type EmailField } from "./reportEmailTemplate";
import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";

/**
 * Emails every ADMIN-role user a copy of a just-submitted report. Best-effort only —
 * any failure (missing API key, network error, no admins configured) is logged and
 * swallowed so it can never affect the report submission itself.
 */
export async function notifyReportSubmission({
  reportType,
  submittedAt,
  submittedByName,
  submittedByStaffNo,
  fields,
}: {
  reportType: ReportType;
  submittedAt: string;
  submittedByName: string;
  submittedByStaffNo: string;
  fields: EmailField[];
}): Promise<void> {
  try {
    const supabase = await createClient();
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
