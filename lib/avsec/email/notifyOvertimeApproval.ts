import { createClient } from "@/lib/avsec/supabase/server";
import { sendEmail } from "./resend";
import { buildReportEmailHtml } from "./reportEmailTemplate";

/**
 * Emails every ADMIN-role user when an overtime request is approved — same best-effort,
 * failure-swallowing contract as notifyReportSubmission (never blocks the approval).
 */
export async function notifyOvertimeApproval({
  requestId,
  submitterName,
  submitterStaffNo,
  station,
  team,
  workDate,
  payableHours,
  category,
  approvedByName,
}: {
  requestId: string;
  submitterName: string;
  submitterStaffNo: string;
  station: string;
  team: string | null;
  workDate: string;
  payableHours: number;
  category: string;
  approvedByName: string;
}): Promise<void> {
  try {
    const supabase = await createClient();
    const { data: adminEmails, error } = await supabase.rpc("get_admin_emails");

    if (error || !adminEmails || adminEmails.length === 0) {
      return;
    }

    const html = buildReportEmailHtml({
      reportName: "Overtime Request Approved",
      formCode: "OT",
      submittedAt: workDate,
      submittedByName: submitterName,
      submittedByStaffNo: submitterStaffNo,
      fields: [
        { label: "Station", value: station },
        { label: "Team", value: team ?? "—" },
        { label: "Work date", value: workDate },
        { label: "Category", value: category.replace(/_/g, " ") },
        { label: "Payable hours", value: `${payableHours}h` },
        { label: "Approved by", value: approvedByName },
        { label: "Request ID", value: requestId.slice(0, 8) },
      ],
    });

    const result = await sendEmail({
      to: adminEmails as string[],
      subject: `Overtime approved — ${submitterName} (${payableHours}h)`,
      html,
    });

    if (!result.ok) {
      console.error(`[notifyOvertimeApproval] ${result.error}`);
    }
  } catch (err) {
    console.error("[notifyOvertimeApproval] failed:", err);
  }
}
