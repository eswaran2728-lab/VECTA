import * as XLSX from "xlsx";
import type { ReportType } from "@/lib/reference-data";

const SHEET_COLUMNS: Record<ReportType, { key: string; header: string }[]> = {
  sec016: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Name" },
    { key: "staff_no", header: "Staff No" },
    { key: "duty_date", header: "Duty Date" },
    { key: "duty_hour", header: "Duty Hour" },
    { key: "flight", header: "Flight" },
    { key: "origin_arr_dep", header: "Origin Arr/Dep" },
    { key: "aircraft_type", header: "Aircraft Type" },
    { key: "reg_no", header: "Reg No" },
    { key: "bay_no", header: "Bay No" },
    { key: "sta_std", header: "STA/STD" },
    { key: "ata_atd", header: "ATA/ATD" },
    { key: "do_infmd", header: "D/O Infmd" },
    { key: "cargo_hold_checked", header: "Cargo Hold Checked" },
    { key: "staff_frisked", header: "Staff Frisked" },
    { key: "discrepancies", header: "Discrepancies" },
    { key: "offload_flight_no", header: "Offload Flight No" },
    { key: "offload_destination", header: "Offload Destination" },
    { key: "offload_total_baggage", header: "Offload Total Baggage" },
  ],
  sec014: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Name" },
    { key: "staff_id", header: "Staff ID" },
    { key: "date_time_in", header: "Date/Time In" },
    { key: "date_time_out", header: "Date/Time Out" },
    { key: "remark", header: "Remark" },
  ],
  sec029: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Staff Name" },
    { key: "staff_id", header: "Staff ID" },
    { key: "aircraft_type", header: "Aircraft Type" },
    { key: "flight_no", header: "Flight No" },
    { key: "aircraft_registration", header: "Aircraft Reg" },
    { key: "parking_bay", header: "Parking Bay" },
    { key: "time_commence", header: "Time Commence" },
    { key: "time_completed", header: "Time Completed" },
    { key: "pic_informed", header: "PIC Informed" },
    { key: "declaration", header: "Declaration" },
    { key: "d_remark", header: "Remark/Detection" },
  ],
  sec018: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Name" },
    { key: "date_time", header: "Date/Time" },
  ],
  sec033: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Name" },
    { key: "staff_id", header: "Staff ID" },
    { key: "report_date", header: "Date" },
    { key: "report_time", header: "Time" },
  ],
  sec013: [
    { key: "report_no", header: "Report No" },
    { key: "submitted_at", header: "Submitted At" },
    { key: "station", header: "Hub/Station" },
    { key: "team", header: "Team" },
    { key: "staff_name", header: "Name" },
    { key: "staff_id", header: "Staff ID" },
    { key: "date_time_in", header: "Date/Time In" },
    { key: "date_time_out", header: "Date/Time Out" },
    { key: "remark", header: "Remark" },
    { key: "corrective_action", header: "Corrective Action" },
  ],
};

export function buildExportWorkbook(
  data: Record<ReportType, Record<string, unknown>[]>,
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  (Object.keys(data) as ReportType[]).forEach((type) => {
    const columns = SHEET_COLUMNS[type];
    const rows = data[type];
    const sheetData = [
      columns.map((c) => c.header),
      ...rows.map((row) => columns.map((c) => row[c.key] ?? "")),
    ];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, type.toUpperCase());
  });

  return wb;
}
