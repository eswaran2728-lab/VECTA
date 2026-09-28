import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { requireProfile } from "@/lib/avsec/auth";
import { getReportById } from "@/lib/avsec/reports/queries";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import { createClient } from "@/lib/supabase/server";
import { Sec016Pdf } from "@/lib/avsec/export/pdf/Sec016Pdf";
import { Sec014Pdf } from "@/lib/avsec/export/pdf/Sec014Pdf";
import { Sec029Pdf } from "@/lib/avsec/export/pdf/Sec029Pdf";
import { Sec018Pdf } from "@/lib/avsec/export/pdf/Sec018Pdf";
import { Sec033Pdf } from "@/lib/avsec/export/pdf/Sec033Pdf";
import { Sec013Pdf } from "@/lib/avsec/export/pdf/Sec013Pdf";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row, Sec033Row, Sec013Row } from "@/lib/avsec/types";

export async function GET(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ type: string; id: string }> },
) {
  const params = await paramsPromise;
  await requireProfile();

  if (!REPORT_TYPES.includes(params.type as ReportType)) {
    return NextResponse.json({ error: "Unknown report type" }, { status: 404 });
  }
  const type = params.type as ReportType;

  // getReportById() already enforces has_report_access() (atomically,
  // via get_report_secure()) and fails closed (ReportNotIndexedError /
  // thrown RPC error) if this report isn't indexed or the caller isn't
  // authorized -- report content itself is never fetched a second time.
  // This second, smaller call is purely to record a DISTINCT
  // 'pdf_generated' audit event (vs. getReportById's own 'detail_view')
  // -- it re-derives the same repository id and is authorized by the
  // identical has_report_access() check, so it cannot itself become a
  // bypass or a second, divergent decision. 'pdf_generated' represents
  // BOTH generation and delivery: this route renders the PDF buffer and
  // streams it back in the SAME HTTP response that triggered generation
  // -- there is no separate, later download step to distinguish (see
  // Part W of the migration).
  const report = await getReportById(type, params.id);
  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }
  const supabase = await createClient();
  const { data: indexRow } = await supabase
    .from("central_reports_index")
    .select("id")
    .eq("source_table", REPORT_META[type].table)
    .eq("source_id", params.id)
    .maybeSingle();
  if (indexRow) {
    await supabase.rpc("authorize_report_pdf_secure", { p_repository_report_id: indexRow.id });
  }

  const reportNo = (report as { report_no?: string | null }).report_no;
  const qrDataUrl = reportNo ? await QRCode.toDataURL(reportNo, { margin: 1, width: 160 }).catch(() => null) : null;

  let buffer: Buffer;
  switch (type) {
    case "sec016":
      buffer = await renderToBuffer(<Sec016Pdf report={report as unknown as Sec016Row} qrDataUrl={qrDataUrl} />);
      break;
    case "sec014":
      buffer = await renderToBuffer(<Sec014Pdf report={report as unknown as Sec014Row} qrDataUrl={qrDataUrl} />);
      break;
    case "sec029":
      buffer = await renderToBuffer(<Sec029Pdf report={report as unknown as Sec029Row} qrDataUrl={qrDataUrl} />);
      break;
    case "sec018":
      buffer = await renderToBuffer(<Sec018Pdf report={report as unknown as Sec018Row} qrDataUrl={qrDataUrl} />);
      break;
    case "sec033":
      buffer = await renderToBuffer(<Sec033Pdf report={report as unknown as Sec033Row} qrDataUrl={qrDataUrl} />);
      break;
    case "sec013":
      buffer = await renderToBuffer(<Sec013Pdf report={report as unknown as Sec013Row} qrDataUrl={qrDataUrl} />);
      break;
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportNo || `${type}-${params.id}`}.pdf"`,
    },
  });
}
