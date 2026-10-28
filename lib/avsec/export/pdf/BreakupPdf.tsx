import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import type { BreakupRow, BreakupBaggageEntry } from "@/lib/avsec/types";

export function BreakupPdf({
  report,
  qrDataUrl,
}: {
  report: BreakupRow & {
    baggage_entries?: BreakupBaggageEntry[];
  };
  qrDataUrl?: string | null;
}) {
  const meta = REPORT_META.breakup;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Flight & Duty Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Operational Date" value={report.duty_date} />
          <PdfField label="Flight Number" value={report.flight_number} />
          <PdfField label="Origin" value={report.origin} />
          <PdfField label="Officer Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id || "-"} />
        </PdfSection>

        <PdfSection title="Timing">
          <PdfField label="First Container Received" value={report.first_container_time} />
          <PdfField label="Last Container Received" value={report.last_container_time} />
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
                <Text style={{ width: 110 }}>Tag: {entry.baggage_tag_no || "N/A"}</Text>
                <Text style={{ flex: 1 }}>Discrepancy: {entry.discrepancy_details || "None"}</Text>
              </View>
            ))}
          {(!report.baggage_entries || report.baggage_entries.length === 0) && (
            <Text style={{ color: "#666", fontSize: 9 }}>No baggage entries recorded.</Text>
          )}
        </View>

        <PdfSection title="Ground Handling & Clearance">
          <PdfFieldFull label="Ground-Handling Personnel" value={report.ground_handling_personnel || "None / Not applicable"} />
          <PdfFieldFull label="PIR / DPR Details" value={report.pir_dpr_details || "None / Not applicable"} />
          <PdfFieldFull
            label="Post-Offload Inspection"
            value={report.containers_inspected_clean ? "Confirmed: Arrival baggage containers inspected after offloading and nothing left behind." : "Unconfirmed"}
          />
        </PdfSection>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
