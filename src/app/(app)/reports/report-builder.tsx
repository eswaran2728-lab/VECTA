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
import { INCIDENT_TYPE_LABELS, STATUS_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/utils";
import type { Incident, Transaction } from "@/lib/database.types";

interface ReportBuilderProps {
  date: string;
  month: string;
  dailyTransactions: Transaction[];
  monthlyTransactions: Pick<Transaction, "status" | "created_at">[];
  monthlyIncidents: Pick<Incident, "incident_type" | "created_at">[];
}

export function ReportBuilder({
  date,
  month,
  dailyTransactions,
  monthlyTransactions,
  monthlyIncidents,
}: ReportBuilderProps) {
  const router = useRouter();

  const monthlySummary = {
    total: monthlyTransactions.length,
    completed: monthlyTransactions.filter((t) => t.status === "COMPLETED").length,
    escalated: monthlyTransactions.filter((t) => t.status === "ESCALATED").length,
    incidents: monthlyIncidents.length,
  };

  const dailyRows = dailyTransactions.map((t) => [
    t.transaction_number,
    t.vehicle_number,
    `${t.driver_name} (${t.driver_id})`,
    t.seal_number,
    STATUS_LABELS[t.status],
    formatDateTime(t.created_at),
  ]);

  const exportDailyPdf = () => {
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(14);
    doc.text(`CSCS Daily Report — ${date}`, 14, 16);
    doc.setFontSize(9);
    doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, 14, 22);
    autoTable(doc, {
      startY: 28,
      head: [["Transaction", "Vehicle", "Driver", "Seal", "Status", "Created"]],
      body: dailyRows,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 64, 175] },
    });
    doc.save(`cscs-daily-${date}.pdf`);
  };

  const exportDailyExcel = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Transaction", "Vehicle", "Driver", "Seal", "Status", "Created"],
      ...dailyRows,
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Daily");
    XLSX.writeFile(wb, `cscs-daily-${date}.xlsx`);
  };

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
    doc.text(`Generated ${new Date().toLocaleString("en-GB")}`, 14, 22);
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
    const summary = XLSX.utils.aoa_to_sheet([
      ["Metric", "Value"],
      ["Total Transactions", monthlySummary.total],
      ["Completed Transactions", monthlySummary.completed],
      ["Escalated Transactions", monthlySummary.escalated],
      ["Total Incidents", monthlySummary.incidents],
    ]);
    XLSX.utils.book_append_sheet(wb, summary, "Summary");
    if (incidentsByType.length > 0) {
      const byType = XLSX.utils.aoa_to_sheet([["Incident Type", "Count"], ...incidentsByType]);
      XLSX.utils.book_append_sheet(wb, byType, "Incidents");
    }
    XLSX.writeFile(wb, `cscs-monthly-${month}.xlsx`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Daily operations report and monthly summary — export as PDF or Excel.
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
                onChange={(e) =>
                  router.push(`/reports?date=${e.target.value}&month=${month}`)
                }
              />
            </div>
            <Button onClick={exportDailyPdf} disabled={dailyTransactions.length === 0}>
              Export PDF
            </Button>
            <Button
              variant="secondary"
              onClick={exportDailyExcel}
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
                <TableHead>Seal</TableHead>
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
                    <TableCell className="font-mono">{t.seal_number}</TableCell>
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
        </CardContent>
      </Card>
    </div>
  );
}
