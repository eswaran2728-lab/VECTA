import { Document, Page } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { REPORT_META } from "@/lib/reference-data";
import { formatDateTimeMY, formatDateMY } from "@/lib/datetime";
import type { Sec016Row } from "@/lib/types";

export function Sec016Pdf({ report }: { report: Sec016Row }) {
  const meta = REPORT_META.sec016;
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title={meta.name} code={meta.code} />

        <PdfSection title="Staff Details">
          <PdfField label="Station" value={report.station} />
          <PdfField label="Team" value={report.team} />
          <PdfField label="Name" value={report.staff_name} />
          <PdfField label="Staff No" value={report.staff_no} />
          <PdfField label="Date" value={formatDateMY(report.duty_date)} />
          <PdfField label="Duty Hour" value={report.duty_hour} />
        </PdfSection>

        <PdfSection title="Aircraft">
          <PdfField label="Flight" value={report.flight} />
          <PdfField label="Origin Arr / Dep" value={report.origin_arr_dep} />
          <PdfField label="Assisted By" value={report.assisted_by} />
          <PdfField
            label="Aircraft Type"
            value={report.aircraft_type === "Other" ? report.aircraft_type_other : report.aircraft_type}
          />
          <PdfField label="Reg No" value={report.reg_no} />
          <PdfField label="Bay No" value={report.bay_no} />
          <PdfField label="STA / STD" value={report.sta_std} />
          <PdfField label="ATA / ATD" value={report.ata_atd} />
          <PdfField label="Reason for Delay" value={report.reason_for_delay} />
          <PdfField label="D/O INFMD" value={report.do_infmd} />
          <PdfField label="Inbound Baggage" value={report.inbound_baggage} />
          <PdfField label="Outbound Baggage" value={report.outbound_baggage} />
          <PdfField label="Inbound Cargo" value={report.inbound_cargo} />
          <PdfField label="Outbound Cargo" value={report.outbound_cargo} />
          <PdfField label="Inbound Co-Mail / Comart" value={report.inbound_co_mail} />
          <PdfField label="Outbound Co-Mail / Comart" value={report.outbound_co_mail} />
          <PdfFieldFull label="Checked" value={report.checked_items?.join(", ")} />
          <PdfField label="Shift Leader" value={report.shift_leader} />
          <PdfField label="Ramp Staff 1" value={report.ramp_staff_1} />
          <PdfField label="Ramp Staff 2" value={report.ramp_staff_2} />
          <PdfField label="Ramp Staff 3" value={report.ramp_staff_3} />
          <PdfField label="Ramp Staff 4" value={report.ramp_staff_4} />
          <PdfField label="Ramp Staff 5" value={report.ramp_staff_5} />
          <PdfField label="Cargo Hold Checked" value={report.cargo_hold_checked} />
          <PdfField label="Staff Frisked" value={report.staff_frisked} />
          <PdfFieldFull label="Discrepancies" value={report.discrepancies} />
        </PdfSection>

        <PdfSection title="Offload Information (Departure Flight)">
          <PdfField label="Flight No" value={report.offload_flight_no} />
          <PdfField label="Destination" value={report.offload_destination} />
          <PdfField label="Baggage Tag No" value={report.offload_baggage_tag_no} />
          <PdfField label="Total Baggage" value={report.offload_total_baggage} />
          <PdfFieldFull label="Remark" value={report.offload_remark} />
        </PdfSection>

        <PdfFooter submissionId={report.id} submittedAt={formatDateTimeMY(report.submitted_at)} />
      </Page>
    </Document>
  );
}
