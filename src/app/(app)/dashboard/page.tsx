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
    pendingInflightPost,
    pendingAirportPost,
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
    // In-flight Post is the 1st checkpoint outbound, the final checkpoint inbound.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .or(
        "and(direction.eq.OUTBOUND,status.eq.CREATED),and(direction.eq.INBOUND,status.eq.AIRPORT_POST_APPROVED)"
      ),
    // Airport Post is the 2nd checkpoint outbound, the 1st checkpoint inbound.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .or(
        "and(direction.eq.OUTBOUND,status.eq.INFLIGHT_POST_APPROVED),and(direction.eq.INBOUND,status.eq.CREATED)"
      ),
    // Part D exists on outbound only.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("direction", "OUTBOUND")
      .eq("status", "AIRPORT_POST_APPROVED"),
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
    { label: "Pending In-flight Post", value: pendingInflightPost.count ?? 0, href: "/transactions" },
    { label: "Pending Airport Post", value: pendingAirportPost.count ?? 0, href: "/transactions" },
    { label: "Pending Part D (outbound)", value: pendingPartD.count ?? 0, href: "/transactions?status=AIRPORT_POST_APPROVED" },
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
