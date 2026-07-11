import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { minutesBetween } from "@/lib/utils";
import { ReportBuilder, type RangeRow } from "./report-builder";
import type { Direction, Incident, TransactionStatus } from "@/lib/database.types";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

interface MonthlyTx {
  status: TransactionStatus;
  created_at: string;
  direction: Direction;
  catering_companies: { name: string } | null;
  part_a: { completed_at: string } | null;
  part_b: { completed_at: string } | null;
  part_c: { completed_at: string } | null;
  part_d: { completed_at: string } | null;
}

function pt(p: { completed_at: string } | { completed_at: string }[] | null): string | null {
  if (!p) return null;
  return Array.isArray(p) ? (p[0]?.completed_at ?? null) : p.completed_at;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; month?: string; from?: string; to?: string }>;
}) {
  await requireRole(["supervisor"]);
  const params = await searchParams;
  const supabase = await createClient();

  const date = params.date ?? new Date().toISOString().slice(0, 10);
  const month = params.month ?? new Date().toISOString().slice(0, 7);
  const rangeFrom = params.from ?? `${month}-01`;
  const rangeTo = params.to ?? new Date().toISOString().slice(0, 10);

  const dayStart = new Date(`${date}T00:00:00`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59.999`).toISOString();
  const [y, m] = month.split("-").map(Number);
  const monthStart = new Date(y, m - 1, 1).toISOString();
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999).toISOString();
  const rangeStart = new Date(`${rangeFrom}T00:00:00`).toISOString();
  const rangeEnd = new Date(`${rangeTo}T23:59:59.999`).toISOString();

  const [daily, monthlyTx, monthlyIncidents, rangeTx] = await Promise.all([
    supabase
      .from("transactions")
      .select("*, seals(seal_number)")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at"),
    supabase
      .from("transactions")
      .select(
        "status, created_at, direction, catering_companies(name), part_a(completed_at), part_b(completed_at), part_c(completed_at), part_d(completed_at)"
      )
      .gte("created_at", monthStart)
      .lte("created_at", monthEnd)
      .limit(3000),
    supabase
      .from("incidents")
      .select("incident_type, created_at, status")
      .gte("created_at", monthStart)
      .lte("created_at", monthEnd),
    supabase
      .from("transactions")
      .select("*, seals(seal_number), catering_companies(name)")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd)
      .order("created_at")
      .limit(5000),
  ]);

  const monthly = (monthlyTx.data ?? []) as unknown as MonthlyTx[];

  // Per-catering-company breakdown for the month.
  const companyMap = new Map<string, { total: number; completed: number; escalated: number }>();
  for (const t of monthly) {
    const name = t.catering_companies?.name ?? "Unassigned";
    const entry = companyMap.get(name) ?? { total: 0, completed: 0, escalated: 0 };
    entry.total += 1;
    if (t.status === "COMPLETED") entry.completed += 1;
    if (t.status === "ESCALATED") entry.escalated += 1;
    companyMap.set(name, entry);
  }
  const companyBreakdown = [...companyMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total);

  // Average dwell times per direction segment for the month.
  const seg = { ab: [] as number[], bc: [] as number[], cd: [] as number[], ac: [] as number[], cb: [] as number[] };
  for (const t of monthly) {
    const a = pt(t.part_a);
    const b = pt(t.part_b);
    const c = pt(t.part_c);
    const d = pt(t.part_d);
    if (t.direction === "OUTBOUND") {
      const ab = minutesBetween(a, b);
      const bc = minutesBetween(b, c);
      const cd = minutesBetween(c, d);
      if (ab !== null && ab >= 0) seg.ab.push(ab);
      if (bc !== null && bc >= 0) seg.bc.push(bc);
      if (cd !== null && cd >= 0) seg.cd.push(cd);
    } else {
      const ac = minutesBetween(a, c);
      const cb = minutesBetween(c, b);
      if (ac !== null && ac >= 0) seg.ac.push(ac);
      if (cb !== null && cb >= 0) seg.cb.push(cb);
    }
  }
  const dwell = [
    { segment: "Outbound A → B", minutes: avg(seg.ab) },
    { segment: "Outbound B → C", minutes: avg(seg.bc) },
    { segment: "Outbound C → D", minutes: avg(seg.cd) },
    { segment: "Inbound A → C", minutes: avg(seg.ac) },
    { segment: "Inbound C → B", minutes: avg(seg.cb) },
  ];

  return (
    <ReportBuilder
      date={date}
      month={month}
      rangeFrom={rangeFrom}
      rangeTo={rangeTo}
      dailyTransactions={(daily.data ?? []) as unknown as RangeRow[]}
      rangeTransactions={(rangeTx.data ?? []) as unknown as RangeRow[]}
      monthlySummary={{
        total: monthly.length,
        completed: monthly.filter((t) => t.status === "COMPLETED").length,
        escalated: monthly.filter((t) => t.status === "ESCALATED").length,
        incidents: (monthlyIncidents.data ?? []).length,
      }}
      monthlyIncidents={
        (monthlyIncidents.data ?? []) as Pick<Incident, "incident_type" | "created_at">[]
      }
      companyBreakdown={companyBreakdown}
      dwell={dwell}
    />
  );
}
