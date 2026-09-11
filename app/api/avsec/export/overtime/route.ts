import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { requireRole } from "@/lib/avsec/auth";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { createClient } from "@/lib/supabase/server";
import { computePeriodDateRange, type PeriodType } from "@/lib/avsec/duty/merged-attendance-queries";
import { formatDateMY, formatTimeMY } from "@/lib/avsec/datetime";

export async function GET(request: NextRequest) {
  await requireRole([...ORG_WIDE_ROLES]);

  const params = request.nextUrl.searchParams;
  const periodType = (params.get("periodType") as PeriodType) || (params.get("year") ? "year" : params.get("month") ? "month" : "day");
  const date = params.get("date") || undefined;
  const month = params.get("month") || undefined;
  const year = params.get("year") || undefined;
  const station = params.get("station") || undefined;
  const team = params.get("team") || undefined;
  const search = params.get("q") || undefined;
  const statusFilter = params.get("status") || undefined;

  const { dateFrom, dateTo, selectedDate, selectedMonth, selectedYear } = computePeriodDateRange({
    periodType,
    date,
    month,
    year,
    station,
    team,
  });

  const supabase = await createClient();

  // Query Overtime Records
  let otQuery = supabase
    .from("overtime_requests")
    .select(`
      id,
      profile_id,
      station,
      team,
      work_date,
      shift_code,
      start_at,
      end_at,
      hours,
      payable_hours,
      category,
      reason,
      status,
      endorsed_by,
      endorsed_at,
      approved_by,
      approved_at,
      rejection_reason,
      linked_duty_id
    `)
    .gte("work_date", dateFrom)
    .lte("work_date", dateTo)
    .order("work_date", { ascending: false });

  if (station) otQuery = otQuery.eq("station", station);
  if (team) otQuery = otQuery.eq("team", team);
  if (statusFilter && statusFilter !== "ALL") otQuery = otQuery.eq("status", statusFilter.toLowerCase());

  const { data: rawOt } = await otQuery;
  const otRows = rawOt ?? [];

  // Fetch relevant profiles
  const profileIds = [...new Set(otRows.map((r) => r.profile_id).filter((id): id is string => Boolean(id)))];
  const reviewerIds = [...new Set(otRows.flatMap((r) => [r.approved_by, r.endorsed_by]).filter((id): id is string => Boolean(id)))];
  const allProfileIds: string[] = [...new Set([...profileIds, ...reviewerIds])];

  let profiles: Array<{ id: string; name: string; staff_no: string }> = [];
  if (allProfileIds.length > 0) {
    const { data: profData } = await supabase
      .from("profiles")
      .select("id, name, staff_no")
      .in("id", allProfileIds);
    profiles = profData ?? [];
  }

  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  // Fetch linked duty records to obtain actual check-out timestamps
  const dutyIds = otRows.map((r) => r.linked_duty_id).filter(Boolean) as string[];
  let dutyRecords: Array<{ id: string; check_in_at: string | null; check_out_at: string | null }> = [];
  if (dutyIds.length > 0) {
    const { data: dData } = await supabase
      .from("duty_records")
      .select("id, check_in_at, check_out_at")
      .in("id", dutyIds);
    dutyRecords = dData ?? [];
  }
  const dutyMap = new Map(dutyRecords.map((d) => [d.id, d]));

  // Build rows for export
  let formattedRows = otRows.map((r) => {
    const submitter = profileMap.get(r.profile_id);
    const reviewer = r.approved_by ? profileMap.get(r.approved_by) : r.endorsed_by ? profileMap.get(r.endorsed_by) : null;
    const duty = r.linked_duty_id ? dutyMap.get(r.linked_duty_id) : null;

    const scheduledEndStr = r.start_at ? formatTimeMY(r.start_at) : "—";
    const actualCheckOutStr = duty?.check_out_at ? formatTimeMY(duty.check_out_at) : (r.end_at ? formatTimeMY(r.end_at) : "—");

    return {
      staffName: submitter?.name ?? "Unknown",
      staffNo: submitter?.staff_no ?? "",
      station: r.station,
      team: r.team ?? "",
      workDate: formatDateMY(r.work_date + "T00:00:00+08:00"),
      shiftCode: r.shift_code ?? "—",
      scheduledEnd: scheduledEndStr,
      actualCheckOut: actualCheckOutStr,
      payableHours: r.payable_hours ?? 0,
      totalHours: Number(r.hours ?? 0).toFixed(2),
      category: (r.category ?? "adhoc").replace(/_/g, " "),
      status: (r.status ?? "pending").toUpperCase(),
      reason: r.reason ?? "",
      reviewedBy: reviewer ? `${reviewer.name} (${reviewer.staff_no})` : "—",
      reviewedAt: r.approved_at ? formatDateMY(r.approved_at) : r.endorsed_at ? formatDateMY(r.endorsed_at) : "—",
      rejectionReason: r.rejection_reason ?? "",
    };
  });

  if (search?.trim()) {
    const q = search.trim().toLowerCase();
    formattedRows = formattedRows.filter(
      (r) => r.staffName.toLowerCase().includes(q) || r.staffNo.toLowerCase().includes(q)
    );
  }

  const columns = [
    "Staff Name",
    "Staff ID",
    "Station",
    "Team",
    "Work Date",
    "Scheduled Shift",
    "Scheduled End",
    "Actual Check-Out",
    "Payable OT (Hours)",
    "Total Excess Duration (Hours)",
    "Category",
    "Status",
    "Reason / Remark",
    "Reviewed By",
    "Reviewed Date",
    "Review / Rejection Note",
  ];

  const sheetData = [
    columns,
    ...formattedRows.map((r) => [
      r.staffName,
      r.staffNo,
      r.station,
      r.team,
      r.workDate,
      r.shiftCode,
      r.scheduledEnd,
      r.actualCheckOut,
      r.payableHours,
      r.totalHours,
      r.category,
      r.status,
      r.reason,
      r.reviewedBy,
      r.reviewedAt,
      r.rejectionReason,
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "OVERTIME_RECORDS");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const labelSuffix = periodType === "day" ? selectedDate : periodType === "month" ? selectedMonth : selectedYear;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="vecta-overtime-export-${labelSuffix}.xlsx"`,
    },
  });
}
