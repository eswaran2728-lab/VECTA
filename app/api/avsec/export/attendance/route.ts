import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { requireRole } from "@/lib/avsec/auth";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { getAttendanceRows, applyAttendanceFlag, type AttendanceFlag } from "@/lib/avsec/duty/attendance-queries";
import { formatDateMY, formatTimeMY, todayISODateMY } from "@/lib/avsec/datetime";

const FLAG_VALUES: AttendanceFlag[] = ["all", "missing", "noshow", "offschedule"];

function formatHours(minutes: number | null): string {
  if (minutes == null) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export async function GET(request: NextRequest) {
  await requireRole([...ORG_WIDE_ROLES]);

  const params = request.nextUrl.searchParams;
  const today = todayISODateMY();
  const dateFrom = params.get("dateFrom") || today;
  const dateTo = params.get("dateTo") || today;
  const station = params.get("station") || undefined;
  const team = params.get("team") || undefined;
  const search = params.get("q") || undefined;
  const flagParam = params.get("flag") as AttendanceFlag | null;
  const flag: AttendanceFlag = flagParam && FLAG_VALUES.includes(flagParam) ? flagParam : "all";

  const allRows = await getAttendanceRows({ station, team, dateFrom, dateTo, search });
  const rows = applyAttendanceFlag(allRows, flag);

  const columns = [
    "Employee",
    "Staff No",
    "Station",
    "Team",
    "Date",
    "Check In",
    "Check Out",
    "Total Hours",
    "No-Show",
    "Missing Checkout",
    "Off-Schedule",
    "OT (unmatched)",
  ];
  const sheetData = [
    columns,
    ...rows.map((r) => [
      r.staff_name,
      r.staff_no,
      r.station,
      r.team ?? "",
      formatDateMY(r.duty_date),
      formatTimeMY(r.check_in_at),
      r.is_missing_checkout ? "Missing" : formatTimeMY(r.check_out_at),
      r.is_missing_checkout ? "" : formatHours(r.total_minutes),
      r.is_no_show ? "Yes" : "",
      r.is_missing_checkout ? "Yes" : "",
      r.is_off_schedule ? "Yes" : "",
      r.ot_minutes != null && !r.ot_request_id ? formatHours(r.ot_minutes) : "",
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ATTENDANCE");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="attendance-report-${dateFrom}-to-${dateTo}.xlsx"`,
    },
  });
}
