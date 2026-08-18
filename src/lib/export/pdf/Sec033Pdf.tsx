import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfSection, PdfFooter, PdfDisclaimer } from "./common";
import { REPORT_META, SECURITY_DISCLAIMER } from "@/lib/reference-data";
import { formatDateMY, formatTimeMY, formatDateTimeMY } from "@/lib/datetime";
import type { Sec033Row, Sec033HoldCheckEntry } from "@/lib/types";

export function Sec033Pdf({
  report,
  qrDataUrl,
}: {
  report: Sec033Row & { hold_checks?: Sec033HoldCheckEntry[] };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.sec033;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />
        <PdfDisclaimer text={SECURITY_DISCLAIMER} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id} />
          <PdfField label="Date" value={formatDateMY(report.report_date)} />
          <PdfField label="Time" value={formatTimeMY(report.report_time)} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Hold Check Details</Text>
          {(report.hold_checks ?? []).map((entry) => (
            <View key={entry.entry_no} style={s.checklistRow}>
              <Text>
                Hold Check #{entry.entry_no} — Bay {entry.parking_bay_no} · Reg{" "}
                {entry.aircraft_registration_no}
              </Text>
              <Text style={{ maxWidth: 220 }}>{entry.remarks || "-"}</Text>
            </View>
          ))}
          {(!report.hold_checks || report.hold_checks.length === 0) && (
            <Text>No hold check entries recorded.</Text>
          )}
        </View>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
