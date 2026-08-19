import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import type { Sec014Row, Sec014PatrolEntry } from "@/lib/avsec/types";

export function Sec014Pdf({
  report,
  qrDataUrl,
}: {
  report: Sec014Row & { patrols?: Sec014PatrolEntry[] };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.sec014;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id} />
          <PdfField label="Date & Time In" value={formatDateTimeMY(report.date_time_in)} />
          <PdfField label="Date & Time Out" value={formatDateTimeMY(report.date_time_out)} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Patrolling</Text>
          {Array.from({ length: 15 }).map((_, i) => {
            const entry = report.patrols?.find((p) => p.entry_no === i + 1);
            return (
              <View key={i} style={s.checklistRow}>
                <Text>
                  {i + 1}. {entry?.location ?? "-"} ({entry?.time_from ?? "-"}–{entry?.time_to ?? "-"})
                </Text>
                <Text style={{ maxWidth: 280 }}>{entry?.description ?? ""}</Text>
              </View>
            );
          })}
        </View>

        <PdfSection title="Remark">
          <PdfFieldFull label="Issue(s) / Event(s) / Equipment(s)" value={report.remark} />
        </PdfSection>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
