import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { requireRole, MONITOR_ROLES } from "@/lib/auth";
import { getFullRowsForExport } from "@/lib/export/queries";
import { buildExportWorkbook } from "@/lib/export/excel";
import type { ReportType } from "@/lib/reference-data";
import { todayISODateMY } from "@/lib/datetime";
import type { DashboardFilters } from "@/lib/dashboard/queries";

export async function GET(request: NextRequest) {
  await requireRole(MONITOR_ROLES);

  const params = request.nextUrl.searchParams;
  const today = todayISODateMY();
  const filters: DashboardFilters = {
    dateFrom: params.get("dateFrom") || today,
    dateTo: params.get("dateTo") || today,
    station: params.get("station") || undefined,
    team: params.get("team") || undefined,
    reportType: (params.get("reportType") as ReportType) || undefined,
  };

  const data = await getFullRowsForExport(filters);
  const workbook = buildExportWorkbook(data);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="avsec-ops-export-${filters.dateFrom}-to-${filters.dateTo}.xlsx"`,
    },
  });
}
