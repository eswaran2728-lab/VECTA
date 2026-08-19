// Reusable HTML email template for report submission notifications — shared by every
// report type so the layout only needs to be built once. Escapes all values (report data
// is user-entered) before interpolating into HTML.

import { APP_NAME } from "@/lib/branding";

export interface EmailField {
  label: string;
  value: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildReportEmailHtml({
  reportName,
  formCode,
  submittedAt,
  submittedByName,
  submittedByStaffNo,
  fields,
}: {
  reportName: string;
  formCode: string;
  submittedAt: string;
  submittedByName: string;
  submittedByStaffNo: string;
  fields: EmailField[];
}): string {
  const rows = fields
    .map(
      (f) => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600;font-size:13px;color:#334155;white-space:nowrap;">${escapeHtml(f.label)}</td>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#0f172a;">${escapeHtml(f.value || "—")}</td>
        </tr>`,
    )
    .join("");

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
    <div style="background:#0f172a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <p style="margin:0;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;opacity:0.7;">${escapeHtml(APP_NAME)}</p>
      <h1 style="margin:4px 0 0;font-size:18px;">${escapeHtml(reportName)}</h1>
      <p style="margin:4px 0 0;font-size:12px;font-family:monospace;opacity:0.85;">${escapeHtml(formCode)}</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:16px 20px;border-radius:0 0 8px 8px;">
      <p style="margin:0 0 12px;font-size:13px;color:#475569;">
        Submitted by <strong>${escapeHtml(submittedByName)}</strong>${submittedByStaffNo ? ` (${escapeHtml(submittedByStaffNo)})` : ""}
        on ${escapeHtml(submittedAt)}.
      </p>
      <table style="width:100%;border-collapse:collapse;">
        ${rows}
      </table>
    </div>
  </div>`;
}
