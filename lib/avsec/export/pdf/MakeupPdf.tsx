import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import type { MakeupRow, MakeupBaggageEntry, MakeupDiscrepancy } from "@/lib/avsec/types";

export function MakeupPdf({
  report,
  qrDataUrl,
}: {
  report: MakeupRow & {
    baggage_entries?: MakeupBaggageEntry[];
    discrepancies?: MakeupDiscrepancy[];
  };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.makeup;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Flight & Duty Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Operational Date" value={report.duty_date} />
          <PdfField label="Flight Number" value={report.flight_number} />
          <PdfField label="Destination" value={report.destination} />
          <PdfField label="Officer Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id || "-"} />
        </PdfSection>

        <PdfSection title="Timing">
          <PdfField label="First Baggage Received" value={report.first_baggage_time} />
          <PdfField label="Last Baggage Tag Received" value={report.last_baggage_tag_time} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Baggage Entries</Text>
          {(report.baggage_entries ?? [])
            .slice()
            .sort((a, b) => a.entry_no - b.entry_no)
            .map((entry) => (
              <View key={entry.entry_no} style={s.checklistRow}>
                <Text style={{ fontWeight: "bold", width: 30 }}>#{entry.entry_no}</Text>
                <Text style={{ width: 140 }}>Container: {entry.container_pallet_trolley_no}</Text>
                <Text style={{ width: 110 }}>Seal: {entry.seal_no}</Text>
                <Text style={{ width: 90 }}>Bay: {entry.bay}</Text>
                <Text style={{ width: 90 }}>Dest: {entry.destination}</Text>
              </View>
            ))}
          {(!report.baggage_entries || report.baggage_entries.length === 0) && (
            <Text style={{ color: "#666", fontSize: 9 }}>No baggage entries recorded.</Text>
          )}
        </View>

        {(report.discrepancies && report.discrepancies.length > 0) && (
          <View style={s.section} wrap>
            <Text style={s.sectionTitle}>Baggage Discrepancies</Text>
            {report.discrepancies
              .slice()
              .sort((a, b) => a.entry_no - b.entry_no)
              .map((disc) => (
                <View key={disc.entry_no} style={s.checklistRow}>
                  <Text style={{ fontWeight: "bold", width: 130 }}>Tag: {disc.baggage_tag_no}</Text>
                  <Text style={{ flex: 1 }}>{disc.details}</Text>
                </View>
              ))}
          </View>
        )}

        <PdfSection title="Ground Handling & Remarks">
          <PdfFieldFull label="Ground-Handling Personnel" value={report.ground_handling_personnel || "None / Not applicable"} />
          <PdfFieldFull label="Remarks / Observations" value={report.remarks || "None"} />
          <PdfFieldFull label="Officer Confirmation" value={report.officer_confirmation ? "Confirmed and verified" : "Unconfirmed"} />
        </PdfSection>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
