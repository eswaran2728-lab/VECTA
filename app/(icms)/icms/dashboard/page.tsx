import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/icms/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardTitle } from "@/components/icms/ui/card";
import { DashboardCharts, type DashTx } from "./dashboard-charts";
import { ExportResetButton } from "./export-reset-button";
import { CountUp } from "@/components/icms/count-up";
import type { Direction, Incident, SegmentTimeout, TransactionStatus } from "@/lib/icms/database.types";
import {
  QrCode,
  TrendingUp,
  PlaneTakeoff,
  Building2,
  PackageCheck,
  CheckCircle2,
  AlertTriangle,
  TriangleAlert,
  Truck,
  PlusCircle,
} from "lucide-react";
import { StatusBadge } from "@/components/icms/status-badge";

export const metadata: Metadata = { title: "CaterLink Dashboard" };
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

  const isDriver = profile.role === "warehouse_pic" || profile.role === "vendor";

  // Dedicated, streamlined Driver View: NO complex analytics or charts.
  // Focused entirely on: + Create New Transaction & Active QR Passes
  if (isDriver) {
    const isVendor = profile.role === "vendor";

    const query = isVendor
      ? supabase
          .from("vendor_transactions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(15)
      : supabase
          .from("transactions")
          .select("*")
          .eq("archived", false)
          .order("created_at", { ascending: false })
          .limit(15);

    const { data: userTx } = await query;

    interface DriverTxItem {
      id: string;
      transaction_number: string;
      status: TransactionStatus;
      vehicle_number?: string | null;
      direction?: Direction | null;
      flight_number?: string | null;
    }

    const activeList = ((userTx ?? []) as unknown as DriverTxItem[]).filter(
      (t) => (t.status as string) !== "COMPLETED" && (t.status as string) !== "ESCALATED"
    );

    return (
      <div className="mx-auto max-w-4xl space-y-6">
        {/* CaterLink Dashboard Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/60 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-amber-500">
                {isVendor ? "CATERLINK · THIRD PARTY DRIVER" : "CATERLINK · IFC DRIVER"}
              </span>
            </div>
            <h1 className="font-heading text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
              CaterLink Dashboard
            </h1>
            <p className="text-sm text-muted-foreground">
              Signed in as <span className="font-semibold text-foreground">{profile.name}</span> (Staff ID:{" "}
              <span className="font-mono text-foreground font-semibold">{profile.staff_id}</span>).
            </p>
          </div>
        </div>

        {/* Primary Hero Card: CREATE NEW TRANSACTION */}
        <div className="relative overflow-hidden rounded-2xl border-2 border-primary/50 bg-gradient-to-br from-primary/15 via-card to-card p-6 shadow-xl shadow-primary/10">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
            <div className="space-y-1.5 max-w-lg">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/20 px-3 py-1 font-mono text-xs font-semibold text-primary">
                <Truck className="h-3.5 w-3.5" /> Departure Dispatch
              </span>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
                {isVendor ? "Start New Delivery" : "Create New Transaction"}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {isVendor
                  ? "Record catering vendor delivery, driver NRIC, and seals. Generates a live QR pass for AVSEC security clearance."
                  : "Start catering movement (Part A). Verify vehicle, assign security seals, and generate your live driver QR pass."}
              </p>
            </div>
            <Link
              href={isVendor ? "/caterlink/vendor-transactions/new" : "/caterlink/transactions/new"}
              className="w-full sm:w-auto shrink-0"
            >
              <button
                type="button"
                className="vecta-btn-primary w-full sm:w-auto text-base px-6 py-4 font-bold flex items-center justify-center gap-2 cursor-pointer shadow-md active:scale-[0.98] transition-transform"
              >
                <PlusCircle className="h-5 w-5" />
                <span>+ Create New Transaction</span>
              </button>
            </Link>
          </div>
        </div>

        {/* Active In-Transit Movements & QR Pass */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              Active Movements &amp; Driver QR Passes
            </h3>
            <span className="font-mono text-xs text-muted-foreground">
              {activeList.length} in transit
            </span>
          </div>

          {activeList.length === 0 ? (
            <Card className="border-dashed bg-surface/30 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No active dispatches right now. Tap &ldquo;+ Create New Transaction&rdquo; above to start a new movement.
              </p>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {activeList.map((tx) => (
                <Card
                  key={tx.id}
                  className="border-primary/30 bg-surface/60 shadow-sm hover:border-primary/60 transition-all"
                >
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-primary">
                        {tx.transaction_number}
                      </span>
                      <StatusBadge status={tx.status} />
                    </div>

                    <div className="text-xs space-y-1 text-muted-foreground">
                      <p>
                        <strong className="text-foreground">Vehicle:</strong> {tx.vehicle_number ?? "—"}
                      </p>
                      <p>
                        <strong className="text-foreground">Direction:</strong> {tx.direction ?? "OUTBOUND"}
                      </p>
                      {tx.flight_number ? (
                        <p>
                          <strong className="text-foreground">Flight:</strong> {tx.flight_number}
                        </p>
                      ) : null}
                    </div>

                    <div className="pt-2 border-t border-border/50">
                      <Link
                        href={
                          isVendor
                            ? `/caterlink/vendor-transactions/${tx.id}`
                            : `/caterlink/transactions/${tx.id}`
                        }
                        className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary py-2.5 px-3 text-xs font-bold transition-colors cursor-pointer"
                      >
                        <QrCode className="h-4 w-4" />
                        <span>Show Driver QR Pass</span>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Quick link to Dispatches list */}
        <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Need full dispatch history?</span>
          <Link
            href={isVendor ? "/caterlink/vendor-transactions" : "/caterlink/transactions"}
            className="font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
          >
            View All Dispatches ➔
          </Link>
        </div>
      </div>
    );
  }

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

  // Amber SLA warning: once a pending transaction crosses ~80% of its
  // segment's time limit, flag its queue before the hard escalation hits.
  const [pendingForSla, segmentLimits] = await Promise.all([
    supabase
      .from("transactions")
      .select("direction, status, status_entered_at")
      .eq("archived", false)
      .in("status", ["CREATED", "INFLIGHT_POST_APPROVED", "AIRPORT_POST_APPROVED"]),
    supabase.from("segment_timeouts").select("direction, from_status, limit_minutes"),
  ]);
  const limitMap = new Map<string, number>();
  for (const row of (segmentLimits.data ?? []) as Pick<
    SegmentTimeout,
    "direction" | "from_status" | "limit_minutes"
  >[]) {
    if (row.limit_minutes !== null) limitMap.set(`${row.direction}:${row.from_status}`, row.limit_minutes);
  }
  const nowMs = Date.now();
  let nearingInflightPost = 0;
  let nearingAirportPost = 0;
  for (const row of (pendingForSla.data ?? []) as {
    direction: Direction;
    status: TransactionStatus;
    status_entered_at: string;
  }[]) {
    const limit = limitMap.get(`${row.direction}:${row.status}`);
    if (!limit) continue;
    const elapsedMinutes = (nowMs - new Date(row.status_entered_at).getTime()) / 60000;
    if (elapsedMinutes < 0.8 * limit) continue;
    // Same queue mapping as pendingInflightPost/pendingAirportPost above.
    const isInflightPostQueue =
      (row.direction === "OUTBOUND" && row.status === "CREATED") ||
      (row.direction === "INBOUND" && row.status === "AIRPORT_POST_APPROVED");
    if (isInflightPostQueue) nearingInflightPost += 1;
    else nearingAirportPost += 1;
  }

  const cards = [
    {
      label: "Total Today",
      value: outCount + inCount,
      sub: `${outCount} out · ${inCount} in`,
      href: "/icms/transactions",
      icon: TrendingUp,
    },
    {
      label: "Pending In-flight Post",
      value: pendingInflightPost.count ?? 0,
      href: "/icms/transactions",
      icon: PlaneTakeoff,
      nearSla: nearingInflightPost,
    },
    {
      label: "Pending Airport Post",
      value: pendingAirportPost.count ?? 0,
      href: "/icms/transactions",
      icon: Building2,
      nearSla: nearingAirportPost,
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
        <Link href="/icms/scan" className="animate-scale-in block">
          <Card className="animate-gradient-pan relative overflow-hidden border-none bg-[linear-gradient(110deg,oklch(var(--brand)),oklch(var(--primary)),oklch(var(--brand)))] text-white shadow-lg shadow-brand/20 transition-transform hover:-translate-y-0.5">
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
          const nearSla = ("nearSla" in card ? card.nearSla : 0) ?? 0;
          const isNearSla = !isAlert && nearSla > 0;
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
                    : isNearSla
                      ? "h-full border-amber-400/50 bg-amber-500/10 transition-all hover:-translate-y-0.5 hover:shadow-md dark:border-amber-800/60"
                      : "h-full transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md"
                }
              >
                <CardContent className="group space-y-2 p-4">
                  <div
                    className={
                      isAlert
                        ? "animate-glow-pulse flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/15 text-orange-500"
                        : isNearSla
                          ? "flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600"
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
                  {isNearSla ? (
                    <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                      ⚠ {nearSla} nearing SLA limit
                    </p>
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
