import { Document, Page, Text, View } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfSection, PdfFooter, PdfDisclaimer } from "./common";
import { REPORT_META, SECURITY_DISCLAIMER, SEC013_CERTIFICATION_TEXT } from "@/lib/reference-data";
import { formatDateTimeMY } from "@/lib/datetime";
import type { Sec013Row, Sec013ProfilingDutyEntry } from "@/lib/types";

export function Sec013Pdf({ report }: { report: Sec013Row & { profiling_duties?: Sec013ProfilingDutyEntry[] } }) {
  const meta = REPORT_META.sec013;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} />
        <PdfDisclaimer text={SECURITY_DISCLAIMER} />

        <PdfSection title="Staff Details">
          <PdfField label="Hub/Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff ID" value={report.staff_id} />
          <PdfField label="Date & Time In" value={formatDateTimeMY(report.date_time_in)} />
          <PdfField label="Date & Time Out" value={formatDateTimeMY(report.date_time_out)} />
        </PdfSection>

        <View style={s.section} wrap>
          <Text style={s.sectionTitle}>Profiling Duty</Text>
          {(report.profiling_duties ?? []).map((entry) => (
            <View key={entry.entry_no} style={{ marginBottom: 6 }}>
              <View style={s.checklistRow}>
                <Text>
                  Duty #{entry.entry_no} — {entry.duty_area} · {entry.location} · {entry.time_from}–
                  {entry.time_to} · Sector/Flight {entry.sector_flight}
                </Text>
              </View>
              <Text style={{ fontSize: 8 }}>{entry.description}</Text>
              {entry.incident_remark && (
                <Text style={{ fontSize: 8, color: "#991b1b" }}>Remark: {entry.incident_remark}</Text>
              )}
            </View>
          ))}
          {(!report.profiling_duties || report.profiling_duties.length === 0) && (
            <Text>No profiling duty entries recorded.</Text>
          )}
        </View>

        <View style={[s.section, { borderWidth: 1.5, borderColor: "#0f172a" }]} wrap={false}>
          <Text style={s.sectionTitle}>Final Remarks &amp; Certification</Text>
          <View style={s.row}>
            <PdfField label="Remark" value={report.remark} />
            <PdfField label="Corrective Action / Follow-up / Recommendation" value={report.corrective_action} />
          </View>
          <Text style={{ fontSize: 8, marginTop: 4 }}>
            {SEC013_CERTIFICATION_TEXT} — {report.acknowledgement ? "Certified" : "Not certified"}
          </Text>
        </View>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
