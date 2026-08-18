import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/reference-data";
import { formatDateMY, formatDateTimeMY } from "@/lib/datetime";
import type { OffloadRow, OffloadItemEntry } from "@/lib/types";

export function OffloadPdf({
  report,
  qrDataUrl,
}: {
  report: OffloadRow & { items?: OffloadItemEntry[] };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.offload;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id} />
        </PdfSection>

        <PdfSection title="Flight Details">
          <PdfField label="Flight No" value={report.flight_no} />
          <PdfField label="Destination" value={report.destination} />
          <PdfField label="Aircraft Registration" value={report.aircraft_registration} />
          <PdfField label="Flight Date" value={formatDateMY(report.flight_date)} />
          <PdfField label="STD" value={report.std} />
          <PdfField label="Total Bags" value={report.total_bags} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Offloaded Baggage</Text>
          {(report.items ?? []).map((entry) => (
            <View key={entry.entry_no} style={s.checklistRow}>
              <Text>
                Bag #{entry.entry_no} — Tag {entry.baggage_tag_no}
                {entry.weight_kg ? ` · ${entry.weight_kg} kg` : ""}
              </Text>
              <Text style={{ maxWidth: 220 }}>{entry.reason || "-"}</Text>
            </View>
          ))}
          {(!report.items || report.items.length === 0) && <Text>No offloaded baggage entries recorded.</Text>}
        </View>

        {report.remark && (
          <PdfSection title="Remark">
            <Text>{report.remark}</Text>
          </PdfSection>
        )}

        {report.verified_by_dse_name && (
          <PdfSection title="DSE Verification">
            <PdfField label="Verified By" value={report.verified_by_dse_name} />
            <PdfField label="DSE Staff ID" value={report.verified_by_dse_id} />
          </PdfSection>
        )}

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
