import { Document, Page } from "@react-pdf/renderer";
import { pdfStyles as s } from "./styles";
import { PdfHeader, PdfField, PdfFieldFull, PdfSection, PdfFooter } from "./common";
import { formatDateTimeMY, formatDateMY } from "@/lib/datetime";
import type { DutyRecordDetail } from "@/lib/duty/types";

function fenceLabel(inside: boolean | null): string {
  if (inside === null) return "—";
  return inside ? "In fence" : "Out of fence";
}

export function DutyRecordPdf({
  record,
  staffName,
  staffNo,
  zoneName,
}: {
  record: DutyRecordDetail;
  staffName: string;
  staffNo: string;
  zoneName: string | null;
}) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <PdfHeader title="Duty Check-In Record" code={`${record.shift_code} SHIFT`} />

        <PdfSection title="Staff & Duty">
          <PdfField label="Station" value={record.station} />
          <PdfField label="Team" value={record.team ?? "—"} />
          <PdfField label="Name" value={staffName} />
          <PdfField label="Staff No" value={staffNo} />
          <PdfField label="Duty Date" value={formatDateMY(`${record.duty_date}T00:00:00+08:00`)} />
          <PdfField label="Zone" value={zoneName ?? "—"} />
        </PdfSection>

        <PdfSection title="Check-In">
          <PdfField label="Time" value={formatDateTimeMY(record.check_in_at)} />
          <PdfField label="Geofence" value={fenceLabel(record.check_in_inside_fence)} />
          <PdfField label="Accuracy" value={record.check_in_accuracy_m ? `±${Math.round(record.check_in_accuracy_m)}m` : "—"} />
          <PdfField label="Submitted offline" value={record.check_in_offline ? "Yes" : "No"} />
        </PdfSection>

        <PdfSection title="Check-Out">
          <PdfField label="Time" value={formatDateTimeMY(record.check_out_at)} />
          <PdfField label="Geofence" value={fenceLabel(record.check_out_inside_fence)} />
        </PdfSection>

        {(record.late_minutes > 0 || record.early_out_minutes > 0) && (
          <PdfSection title="Flags">
            {record.late_minutes > 0 && <PdfFieldFull label={`Late (${record.late_minutes} min)`} value={record.late_remark} />}
            {record.early_out_minutes > 0 && (
              <PdfFieldFull label={`Early out (${record.early_out_minutes} min)`} value={record.early_out_remark} />
            )}
          </PdfSection>
        )}

        {(record.post_assignment || record.handover_notes) && (
          <PdfSection title="Notes">
            {record.post_assignment && <PdfFieldFull label="Post assignment" value={record.post_assignment} />}
            {record.handover_notes && <PdfFieldFull label="Handover notes" value={record.handover_notes} />}
          </PdfSection>
        )}

        <PdfFooter submissionId={record.id} submittedAt={formatDateTimeMY(record.check_in_at)} />
      </Page>
    </Document>
  );
}
