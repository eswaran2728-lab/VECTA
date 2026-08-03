import { createClient } from "@/lib/supabase/server";
import { sendEmail } from "./resend";
import { buildReportEmailHtml, type EmailField } from "./reportEmailTemplate";
import { REPORT_META, type ReportType } from "@/lib/reference-data";

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
  const supabase = createClient();

  async function log(stage: string, detail: string) {
    try {
      await supabase.from("debug_notify_log").insert({ report_type: reportType, stage, detail });
    } catch {
      // debug logging must never affect the caller
    }
  }

  try {
    await log("start", "notifyReportSubmission entered");

    const { data: adminEmails, error } = await supabase.rpc("get_admin_emails");
    await log("rpc_result", JSON.stringify({ error: error?.message, adminEmails }));

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
    await log("html_built", `length=${html.length}`);

    const result = await sendEmail({
      to: adminEmails as string[],
      subject: `${meta.name} submitted by ${submittedByName}`,
      html,
    });
    await log("sendEmail_result", JSON.stringify(result));

    if (!result.ok) {
      console.error(`[notifyReportSubmission] ${reportType}: ${result.error}`);
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    await log("caught_exception", message);
    console.error(`[notifyReportSubmission] ${reportType} failed:`, err);
  }
}
