import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardCharts } from "./dashboard-charts";
import type { Incident, Transaction } from "@/lib/database.types";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default async function DashboardPage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const today = startOfToday();

  const chartWindow = new Date();
  chartWindow.setDate(chartWindow.getDate() - 30);

  const [
    totalToday,
    pendingPost2,
    pendingPost6,
    pendingPartD,
    completedToday,
    escalated,
    recentTransactions,
    recentIncidents,
  ] = await Promise.all([
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .gte("created_at", today),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("status", "CREATED"),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("status", "POST2_APPROVED"),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("status", "POST6_APPROVED"),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("status", "COMPLETED")
      .gte("completed_at", today),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("status", "ESCALATED"),
    supabase
      .from("transactions")
      .select("created_at, completed_at, status")
      .gte("created_at", chartWindow.toISOString())
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("incidents")
      .select("incident_type, created_at")
      .gte("created_at", chartWindow.toISOString())
      .limit(1000),
  ]);

  const cards = [
    { label: "Total Today", value: totalToday.count ?? 0, href: "/transactions" },
    { label: "Pending Post 2", value: pendingPost2.count ?? 0, href: "/transactions?status=CREATED" },
    { label: "Pending Post 6", value: pendingPost6.count ?? 0, href: "/transactions?status=POST2_APPROVED" },
    { label: "Pending Part D", value: pendingPartD.count ?? 0, href: "/transactions?status=POST6_APPROVED" },
    { label: "Completed Today", value: completedToday.count ?? 0, href: "/transactions?status=COMPLETED" },
    { label: "Escalated Cases", value: escalated.count ?? 0, href: "/transactions?status=ESCALATED", alert: true },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {profile.name}. Live view of today&apos;s catering security movements.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((card) => (
          <Link key={card.label} href={card.href}>
            <Card
              className={
                card.alert && card.value > 0
                  ? "border-red-400 bg-red-50 dark:border-red-800 dark:bg-red-950/40"
                  : undefined
              }
            >
              <CardHeader className="p-4 pb-1">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {card.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-3xl font-bold tabular-nums">{card.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <DashboardCharts
        transactions={(recentTransactions.data ?? []) as Pick<
          Transaction,
          "created_at" | "completed_at" | "status"
        >[]}
        incidents={(recentIncidents.data ?? []) as Pick<Incident, "incident_type" | "created_at">[]}
      />
    </div>
  );
}
