import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META, SEC029_ITEMS } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import type { Sec029Row, Sec029ItemEntry } from "@/lib/avsec/types";

export function Sec029Pdf({
  report,
  qrDataUrl,
}: {
  report: Sec029Row & { items?: Sec029ItemEntry[] };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.sec029;
  const itemMap = new Map((report.items ?? []).map((i) => [i.item_code, i]));

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Supervising Officer" value={`${report.supervising_officer_name} (${report.supervising_officer_id})`} />
          <PdfField label="Staff" value={`${report.staff_name} (${report.staff_id})`} />
          <PdfFieldFull label="Assisted By" value={`${report.assisted_by_name} (${report.assisted_by_id})`} />
        </PdfSection>

        <PdfSection title="Aircraft Details">
          <PdfField label="Aircraft Type" value={report.aircraft_type} />
          <PdfField label="Flight No" value={report.flight_no} />
          <PdfField label="Aircraft Registration" value={report.aircraft_registration} />
          <PdfField label="STD" value={report.std} />
          <PdfField label="Parking Bay" value={report.parking_bay} />
          <PdfField label="Time Commence" value={report.time_commence} />
          <PdfField label="Time Completed" value={report.time_completed} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Checklist</Text>
          {SEC029_ITEMS.map((item) => {
            const entry = itemMap.get(item.code);
            return (
              <View key={item.code} style={s.checklistRow}>
                <Text>{item.label}</Text>
                <Text>
                  {entry?.checked ?? "-"}
                  {entry?.remark_type === "other" && entry.remark_text ? ` — ${entry.remark_text}` : ""}
                </Text>
              </View>
            );
          })}
        </View>

        <PdfSection title="Final">
          <PdfField label="Information to PIC" value={report.pic_informed} />
          <PdfFieldFull label="Declaration" value={report.declaration} />
          {report.d_remark && <PdfFieldFull label="Remark / Detection" value={report.d_remark} />}
        </PdfSection>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
