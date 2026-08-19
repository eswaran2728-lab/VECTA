import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { requireProfile } from "@/lib/avsec/auth";
import { getReportById } from "@/lib/avsec/reports/queries";
import { REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import { Sec016Pdf } from "@/lib/avsec/export/pdf/Sec016Pdf";
import { Sec014Pdf } from "@/lib/avsec/export/pdf/Sec014Pdf";
import { Sec029Pdf } from "@/lib/avsec/export/pdf/Sec029Pdf";
import { Sec018Pdf } from "@/lib/avsec/export/pdf/Sec018Pdf";
import { Sec033Pdf } from "@/lib/avsec/export/pdf/Sec033Pdf";
import { Sec013Pdf } from "@/lib/avsec/export/pdf/Sec013Pdf";
import { OffloadPdf } from "@/lib/avsec/export/pdf/OffloadPdf";
import type { Sec016Row, Sec014Row, Sec029Row, Sec018Row, Sec033Row, Sec013Row, OffloadRow } from "@/lib/avsec/types";

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

  const report = await getReportById(type, params.id);
  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
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
    case "offload":
      buffer = await renderToBuffer(<OffloadPdf report={report as unknown as OffloadRow} qrDataUrl={qrDataUrl} />);
      break;
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportNo || `${type}-${params.id}`}.pdf"`,
    },
  });
}
