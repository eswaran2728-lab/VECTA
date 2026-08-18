import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/reference-data";
import { formatDateTimeMY } from "@/lib/datetime";
import type { Sec018Row, Sec018PatrolEntry } from "@/lib/types";

export function Sec018Pdf({
  report,
  qrDataUrl,
}: {
  report: Sec018Row & { patrols?: Sec018PatrolEntry[] };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.sec018;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Date & Time" value={formatDateTimeMY(report.date_time)} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Patrolling Details</Text>
          {Array.from({ length: 6 }).map((_, i) => {
            const entry = report.patrols?.find((p) => p.entry_no === i + 1);
            return (
              <View key={i} style={s.checklistRow}>
                <Text>
                  {i + 1}. {entry?.time_from ?? "-"}–{entry?.time_to ?? "-"} · Bay{" "}
                  {entry?.parking_bay ?? "-"} · {entry?.aircraft_type ?? "-"} · {entry?.reg_no ?? "-"}
                </Text>
                <Text style={{ maxWidth: 220 }}>{entry?.description ?? ""}</Text>
              </View>
            );
          })}
        </View>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.date_time)} />
      </Page>
    </Document>
  );
}
