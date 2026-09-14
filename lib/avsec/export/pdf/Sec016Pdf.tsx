import { Document, Page } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/avsec/reference-data";
import { formatDateTimeMY, formatDateMY } from "@/lib/avsec/datetime";
import type { Sec016Row } from "@/lib/avsec/types";

export function Sec016Pdf({ report, qrDataUrl }: { report: Sec016Row; qrDataUrl?: string | null }) {
  const meta = REPORT_META.sec016;
  const isArrival = (report.flight_type || "arrival") === "arrival";
  // Pre-Rev.03 reports carry the old five individual ramp_staff_N slots instead of the
  // consolidated multiline boxes — fall back to those so historical PDFs still render.
  const rampAgentsBaggage =
    report.ramp_agents_baggage ??
    [report.ramp_staff_1, report.ramp_staff_2, report.ramp_staff_3, report.ramp_staff_4, report.ramp_staff_5]
      .filter(Boolean)
      .join("\n");

  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} reportNo={report.report_no} qrDataUrl={qrDataUrl} />

        <PdfSection title="Staff & Flight Details">
          <PdfField label="Flight Type" value={(report.flight_type || "arrival").toUpperCase()} />
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff No" value={report.staff_no} />
          <PdfField label="Date" value={formatDateMY(report.duty_date)} />
          <PdfField label="Duty Hour" value={report.duty_hour} />
          {!isArrival && (
            <PdfField
              label="Aircraft Search"
              value={report.aircraft_search_completed ? "Completed" : "Not Completed"}
            />
          )}
        </PdfSection>

        <PdfSection title="Aircraft">
          <PdfField label="Flight" value={report.flight} />
          <PdfField label={isArrival ? "Origin (Arrival)" : "Destination (Departure)"} value={report.origin_arr_dep} />
          <PdfField label="Assisted By" value={report.assisted_by} />
          <PdfField
            label="Aircraft Type"
            value={report.aircraft_type === "Other" ? report.aircraft_type_other : report.aircraft_type}
          />
          <PdfField label="Reg No" value={report.reg_no} />
          <PdfField label="Bay No" value={report.bay_no} />
          <PdfField label={isArrival ? "STA" : "STD"} value={report.sta_std} />
          <PdfField label={isArrival ? "ATA" : "ATD"} value={report.ata_atd} />
          <PdfField label="Reason for Delay" value={report.reason_for_delay} />
          <PdfField label="D/O INFMD" value={report.do_infmd} />
          {isArrival ? (
            <>
              <PdfField label="Inbound Baggage" value={report.inbound_baggage} />
              <PdfField label="Inbound Cargo" value={report.inbound_cargo} />
              <PdfField label="Inbound Co-Mail / Comat" value={report.inbound_co_mail} />
            </>
          ) : (
            <>
              <PdfField label="Outbound Baggage" value={report.outbound_baggage} />
              <PdfField label="Outbound Cargo" value={report.outbound_cargo} />
              <PdfField label="Outbound Co-Mail / Comat" value={report.outbound_co_mail} />
            </>
          )}
        </PdfSection>

        <PdfSection title="Ramp Loading Supervisor & Agents">
          <PdfField label="Ramp Loading Supervisor (RLS)" value={report.shift_leader} />
          <PdfFieldFull label="Ramp agent details (baggage)" value={rampAgentsBaggage} />
          <PdfFieldFull label="Ramp agent details (cargo)" value={report.ramp_agents_cargo} />
        </PdfSection>

        <PdfSection title="Security Checks">
          <PdfField label="Cargo Hold Checked" value={report.cargo_hold_checked} />
          <PdfField label="Staff Frisked" value={report.staff_frisked} />
          <PdfField label="Cabin Check" value={report.cabin_check} />
          <PdfFieldFull label="Discrepancies" value={report.discrepancies} />
        </PdfSection>

        {!isArrival && (
          <PdfSection title="Offload Information (Departure Flight)">
            <PdfFieldFull label="Baggage Tag No" value={report.offload_baggage_tag_no} />
            <PdfFieldFull label="Remark" value={report.offload_remark} />
          </PdfSection>
        )}

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
