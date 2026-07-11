"use client";

import { useRouter } from "next/navigation";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { INCIDENT_TYPE_LABELS, STATUS_LABELS, DIRECTION_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import type { Incident, Transaction } from "@/lib/database.types";

export type RangeRow = Transaction & {
  seals: { seal_number: string }[];
  catering_companies?: { name: string } | null;
};

interface MonthlySummary {
  total: number;
  completed: number;
  escalated: number;
  incidents: number;
}

interface ReportBuilderProps {
  date: string;
  month: string;
  rangeFrom: string;
  rangeTo: string;
  dailyTransactions: RangeRow[];
  rangeTransactions: RangeRow[];
  monthlySummary: MonthlySummary;
  monthlyIncidents: Pick<Incident, "incident_type" | "created_at">[];
  companyBreakdown: { name: string; total: number; completed: number; escalated: number }[];
  dwell: { segment: string; minutes: number | null }[];
}

function txRows(list: RangeRow[]): string[][] {
  return list.map((t) => [
    t.transaction_number,
    DIRECTION_LABELS[t.direction],
    t.vehicle_number,
    `${t.driver_name} (${t.driver_id})`,
    t.seals.length > 0 ? t.seals.map((s) => s.seal_number).join(", ") : (t.seal_number ?? "—"),
    t.flight_number ?? "—",
    STATUS_LABELS[t.status],
    formatDateTime(t.created_at),
  ]);
}

const TX_HEAD = ["Transaction", "Direction", "Vehicle", "Driver", "Seals", "Flight", "Status", "Created"];

function exportTxPdf(title: string, list: RangeRow[], filename: string) {
  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(14);
  doc.text(title, 14, 16);
  doc.setFontSize(9);
  doc.text(`Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`, 14, 22);
  autoTable(doc, {
    startY: 28,
    head: [TX_HEAD],
    body: txRows(list),
    styles: { fontSize: 7 },
    headStyles: { fillColor: [30, 64, 175] },
  });
  doc.save(filename);
}

function exportTxExcel(list: RangeRow[], filename: string) {
  const ws = XLSX.utils.aoa_to_sheet([TX_HEAD, ...txRows(list)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Transactions");
  XLSX.writeFile(wb, filename);
}

export function ReportBuilder({
  date,
  month,
  rangeFrom,
  rangeTo,
  dailyTransactions,
  rangeTransactions,
  monthlySummary,
  monthlyIncidents,
  companyBreakdown,
  dwell,
}: ReportBuilderProps) {
  const router = useRouter();

  const incidentsByType = Object.entries(
    monthlyIncidents.reduce<Record<string, number>>((acc, i) => {
      acc[i.incident_type] = (acc[i.incident_type] ?? 0) + 1;
      return acc;
    }, {})
  ).map(([type, count]) => [
    INCIDENT_TYPE_LABELS[type as keyof typeof INCIDENT_TYPE_LABELS] ?? type,
    String(count),
  ]);

  const exportMonthlyPdf = () => {
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text(`CSCS Monthly Report — ${month}`, 14, 16);
    doc.setFontSize(9);
    doc.text(`Generated ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur" })} (MYT)`, 14, 22);
    autoTable(doc, {
      startY: 28,
      head: [["Metric", "Value"]],
      body: [
        ["Total Transactions", String(monthlySummary.total)],
        ["Completed Transactions", String(monthlySummary.completed)],
        ["Escalated Transactions", String(monthlySummary.escalated)],
        ["Total Incidents", String(monthlySummary.incidents)],
      ],
      headStyles: { fillColor: [30, 64, 175] },
    });
    autoTable(doc, {
      head: [["Checkpoint Segment", "Avg Dwell (min)"]],
      body: dwell.map((d) => [d.segment, d.minutes === null ? "—" : String(d.minutes)]),
      headStyles: { fillColor: [5, 150, 105] },
    });
    autoTable(doc, {
      head: [["Catering Company", "Total", "Completed", "Escalated"]],
      body: companyBreakdown.map((c) => [
        c.name,
        String(c.total),
        String(c.completed),
        String(c.escalated),
      ]),
      headStyles: { fillColor: [124, 58, 237] },
    });
    if (incidentsByType.length > 0) {
      autoTable(doc, {
        head: [["Incident Type", "Count"]],
        body: incidentsByType,
        headStyles: { fillColor: [153, 27, 27] },
      });
    }
    doc.save(`cscs-monthly-${month}.pdf`);
  };

  const exportMonthlyExcel = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Metric", "Value"],
        ["Total Transactions", monthlySummary.total],
        ["Completed Transactions", monthlySummary.completed],
        ["Escalated Transactions", monthlySummary.escalated],
        ["Total Incidents", monthlySummary.incidents],
      ]),
      "Summary"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Checkpoint Segment", "Avg Dwell (min)"],
        ...dwell.map((d) => [d.segment, d.minutes ?? "—"]),
      ]),
      "Dwell Times"
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Catering Company", "Total", "Completed", "Escalated"],
        ...companyBreakdown.map((c) => [c.name, c.total, c.completed, c.escalated]),
      ]),
      "By Company"
    );
    if (incidentsByType.length > 0) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([["Incident Type", "Count"], ...incidentsByType]),
        "Incidents"
      );
    }
    XLSX.writeFile(wb, `cscs-monthly-${month}.xlsx`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Daily, monthly, and archive exports — all timestamps in Malaysia time (MYT). No records
          are ever deleted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily Report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="report-date">Date</Label>
              <Input
                id="report-date"
                type="date"
                defaultValue={date}
                onChange={(e) => router.push(`/reports?date=${e.target.value}&month=${month}`)}
              />
            </div>
            <Button
              onClick={() =>
                exportTxPdf(`CSCS Daily Report — ${date}`, dailyTransactions, `cscs-daily-${date}.pdf`)
              }
              disabled={dailyTransactions.length === 0}
            >
              Export PDF
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportTxExcel(dailyTransactions, `cscs-daily-${date}.xlsx`)}
              disabled={dailyTransactions.length === 0}
            >
              Export Excel
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Seals</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyTransactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No transactions on {date}.
                  </TableCell>
                </TableRow>
              ) : (
                dailyTransactions.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono">{t.transaction_number}</TableCell>
                    <TableCell className="font-mono">{t.vehicle_number}</TableCell>
                    <TableCell>
                      {t.driver_name}
                      <span className="block text-xs text-muted-foreground">{t.driver_id}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.seals.map((s) => s.seal_number).join(", ") || (t.seal_number ?? "—")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly Report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="report-month">Month</Label>
              <Input
                id="report-month"
                type="month"
                defaultValue={month}
                onChange={(e) => router.push(`/reports?date=${date}&month=${e.target.value}`)}
              />
            </div>
            <Button onClick={exportMonthlyPdf}>Export PDF</Button>
            <Button variant="secondary" onClick={exportMonthlyExcel}>
              Export Excel
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Total Transactions", value: monthlySummary.total },
              { label: "Completed", value: monthlySummary.completed },
              { label: "Escalated", value: monthlySummary.escalated },
              { label: "Total Incidents", value: monthlySummary.incidents },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border p-4">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="text-2xl font-bold tabular-nums">{item.value}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-semibold">Average dwell times</p>
              <Table>
                <TableBody>
                  {dwell.map((d) => (
                    <TableRow key={d.segment}>
                      <TableCell className="py-2 text-sm">{d.segment}</TableCell>
                      <TableCell className="py-2 text-right font-mono text-sm">
                        {d.minutes === null ? "—" : `${d.minutes} min`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Per catering company</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8">Company</TableHead>
                    <TableHead className="h-8 text-right">Total</TableHead>
                    <TableHead className="h-8 text-right">Done</TableHead>
                    <TableHead className="h-8 text-right">Esc.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companyBreakdown.map((c) => (
                    <TableRow key={c.name}>
                      <TableCell className="py-2 text-sm">{c.name}</TableCell>
                      <TableCell className="py-2 text-right font-mono text-sm">{c.total}</TableCell>
                      <TableCell className="py-2 text-right font-mono text-sm">{c.completed}</TableCell>
                      <TableCell className="py-2 text-right font-mono text-sm">{c.escalated}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Archive Export — any date range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="range-from">From</Label>
              <Input
                id="range-from"
                type="date"
                defaultValue={rangeFrom}
                onChange={(e) =>
                  router.push(`/reports?date=${date}&month=${month}&from=${e.target.value}&to=${rangeTo}`)
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-to">To</Label>
              <Input
                id="range-to"
                type="date"
                defaultValue={rangeTo}
                onChange={(e) =>
                  router.push(`/reports?date=${date}&month=${month}&from=${rangeFrom}&to=${e.target.value}`)
                }
              />
            </div>
            <Button
              onClick={() =>
                exportTxPdf(
                  `CSCS Archive — ${rangeFrom} to ${rangeTo}`,
                  rangeTransactions,
                  `cscs-archive-${rangeFrom}-${rangeTo}.pdf`
                )
              }
              disabled={rangeTransactions.length === 0}
            >
              Export PDF
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportTxExcel(rangeTransactions, `cscs-archive-${rangeFrom}-${rangeTo}.xlsx`)}
              disabled={rangeTransactions.length === 0}
            >
              Export Excel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {rangeTransactions.length} transaction(s) in range (max 5000 per export).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
