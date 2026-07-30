import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { DashboardCharts, type DashTx } from "./dashboard-charts";
import { ExportResetButton } from "./export-reset-button";
import { CountUp } from "@/components/count-up";
import type { Incident } from "@/lib/database.types";
import {
  QrCode,
  TrendingUp,
  PlaneTakeoff,
  Building2,
  PackageCheck,
  CheckCircle2,
  AlertTriangle,
  TriangleAlert,
} from "lucide-react";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const profile = await requireProfile();
  const { error } = await searchParams;
  const supabase = await createClient();
  const today = startOfToday();

  const chartWindow = new Date();
  chartWindow.setDate(chartWindow.getDate() - 30);

  const [
    totalTodayOut,
    totalTodayIn,
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
      .eq("archived", false)
      .eq("direction", "OUTBOUND")
      .gte("created_at", today),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("direction", "INBOUND")
      .gte("created_at", today),
    // In-flight Post is the 1st checkpoint outbound, the final checkpoint inbound.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .or(
        "and(direction.eq.OUTBOUND,status.eq.CREATED),and(direction.eq.INBOUND,status.eq.AIRPORT_POST_APPROVED)"
      ),
    // Airport Post is the 2nd checkpoint outbound, the 1st checkpoint inbound.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .or(
        "and(direction.eq.OUTBOUND,status.eq.INFLIGHT_POST_APPROVED),and(direction.eq.INBOUND,status.eq.CREATED)"
      ),
    // Part D exists on outbound only.
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("direction", "OUTBOUND")
      .eq("status", "AIRPORT_POST_APPROVED"),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("status", "COMPLETED")
      .gte("completed_at", today),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("status", "ESCALATED"),
    supabase
      .from("transactions")
      .select(
        "created_at, completed_at, status, direction, part_a(completed_at), part_b(completed_at), part_c(completed_at), part_d(completed_at)"
      )
      .eq("archived", false)
      .gte("created_at", chartWindow.toISOString())
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase
      .from("incidents")
      .select("incident_type, created_at")
      .gte("created_at", chartWindow.toISOString())
      .limit(1000),
  ]);

  const outCount = totalTodayOut.count ?? 0;
  const inCount = totalTodayIn.count ?? 0;

  const cards = [
    {
      label: "Total Today",
      value: outCount + inCount,
      sub: `${outCount} out · ${inCount} in`,
      href: "/transactions",
      icon: TrendingUp,
    },
    {
      label: "Pending In-flight Post",
      value: pendingInflightPost.count ?? 0,
      href: "/transactions",
      icon: PlaneTakeoff,
    },
    {
      label: "Pending Airport Post",
      value: pendingAirportPost.count ?? 0,
      href: "/transactions",
      icon: Building2,
    },
    {
      label: "Pending Part D (outbound)",
      value: pendingPartD.count ?? 0,
      href: "/transactions?status=AIRPORT_POST_APPROVED",
      icon: PackageCheck,
    },
    {
      label: "Completed Today",
      value: completedToday.count ?? 0,
      href: "/transactions?status=COMPLETED",
      icon: CheckCircle2,
    },
    {
      label: "Escalated Cases",
      value: escalated.count ?? 0,
      href: "/transactions?status=ESCALATED",
      icon: AlertTriangle,
      alert: true,
    },
  ];

  const checkpointQueue =
    profile.role === "post2_avsec"
      ? { label: "Pending In-flight Post", value: pendingInflightPost.count ?? 0 }
      : profile.role === "post6_avsec"
        ? { label: "Pending Airport Post", value: pendingAirportPost.count ?? 0 }
        : profile.role === "receiver"
          ? { label: "Pending Part D", value: pendingPartD.count ?? 0 }
          : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, {profile.name}. Live view of today&apos;s catering security movements.
          </p>
        </div>
        {profile.role === "supervisor" ? <ExportResetButton /> : null}
      </div>

      {error === "forbidden" ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>You don&apos;t have access to that page for your role.</span>
        </div>
      ) : null}

      {checkpointQueue ? (
        <Link href="/scan" className="animate-scale-in block">
          <Card className="animate-gradient-pan relative overflow-hidden border-none bg-[linear-gradient(110deg,hsl(var(--brand)),hsl(var(--primary)),hsl(var(--brand)))] text-white shadow-lg shadow-brand/20 transition-transform hover:-translate-y-0.5">
            <div
              aria-hidden
              className="animate-glow-pulse pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl"
            />
            <CardContent className="relative flex items-center justify-between gap-4 p-5">
              <div>
                <p className="text-sm font-medium text-white/85">{checkpointQueue.label}</p>
                <p className="font-heading text-3xl font-bold tabular-nums">
                  <CountUp value={checkpointQueue.value} />
                </p>
                <p className="mt-1 text-sm text-white/85">Scan QR to verify the next transaction</p>
              </div>
              <div className="animate-float flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/20">
                <QrCode className="h-9 w-9" />
              </div>
            </CardContent>
          </Card>
        </Link>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((card, i) => {
          const isAlert = card.alert && card.value > 0;
          return (
            <Link
              key={card.label}
              href={card.href}
              className="animate-fade-in-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <Card
                className={
                  isAlert
                    ? "h-full border-orange-400/40 bg-orange-500/10 transition-all hover:-translate-y-0.5 hover:shadow-md dark:border-orange-800/60"
                    : "h-full transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
                }
              >
                <CardContent className="group space-y-2 p-4">
                  <div
                    className={
                      isAlert
                        ? "animate-glow-pulse flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/15 text-orange-500"
                        : "flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-110"
                    }
                  >
                    <card.icon className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-xs font-medium text-muted-foreground">
                    {card.label}
                  </CardTitle>
                  <p className="font-heading text-3xl font-bold tabular-nums">
                    <CountUp value={card.value} />
                  </p>
                  {"sub" in card && card.sub ? (
                    <p className="text-xs text-muted-foreground">{card.sub}</p>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="animate-fade-in-up" style={{ animationDelay: "400ms" }}>
        <DashboardCharts
          transactions={(recentTransactions.data ?? []) as unknown as DashTx[]}
          incidents={(recentIncidents.data ?? []) as Pick<Incident, "incident_type" | "created_at">[]}
        />
      </div>
    </div>
  );
}
