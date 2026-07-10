import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ReportBuilder } from "./report-builder";
import type { Incident, Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; month?: string }>;
}) {
  await requireRole(["supervisor"]);
  const params = await searchParams;
  const supabase = await createClient();

  const date = params.date ?? new Date().toISOString().slice(0, 10);
  const month = params.month ?? new Date().toISOString().slice(0, 7);

  const dayStart = new Date(`${date}T00:00:00`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59.999`).toISOString();

  const [y, m] = month.split("-").map(Number);
  const monthStart = new Date(y, m - 1, 1).toISOString();
  const monthEnd = new Date(y, m, 0, 23, 59, 59, 999).toISOString();

  const [daily, monthlyTx, monthlyIncidents] = await Promise.all([
    supabase
      .from("transactions")
      .select("*")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .order("created_at"),
    supabase
      .from("transactions")
      .select("status, created_at")
      .gte("created_at", monthStart)
      .lte("created_at", monthEnd),
    supabase
      .from("incidents")
      .select("incident_type, created_at")
      .gte("created_at", monthStart)
      .lte("created_at", monthEnd),
  ]);

  return (
    <ReportBuilder
      date={date}
      month={month}
      dailyTransactions={(daily.data ?? []) as Transaction[]}
      monthlyTransactions={(monthlyTx.data ?? []) as Pick<Transaction, "status" | "created_at">[]}
      monthlyIncidents={(monthlyIncidents.data ?? []) as Pick<Incident, "incident_type" | "created_at">[]}
    />
  );
}
