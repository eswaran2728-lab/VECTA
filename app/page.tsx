import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/lib/avsec/profile-actions";
import { getFilteredSubmissions } from "@/lib/avsec/dashboard/queries";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { REPORT_TYPES as AVSEC_REPORT_TYPES, REPORT_META } from "@/lib/avsec/reference-data";
import { requiresDailyReport } from "@/lib/avsec/auth";
import { StatusDot, type OpsStatus } from "@/components/layout/StatusDot";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { NotificationsBell } from "@/components/layout/NotificationsBell";
import { TransactionStageBar } from "@/components/layout/TransactionStageBar";
import { getActiveAnnouncementsForUser } from "@/lib/avsec/announcements/queries";
import { getActiveRoleAssignments } from "@/lib/dashboard/context";
import { deriveCanonicalAccess, isOrgWideOperator } from "@/lib/auth/canonical-access";
import { isStationOperator } from "@/lib/icms/canonical";
import { isExternalCaterLinkRole } from "@/lib/supabase/middleware-gate-logic";
import { AnnouncementBanner } from "@/components/avsec/announcements/AnnouncementBanner";
import type { Direction, TransactionRoute, TransactionStatus } from "@/lib/icms/database.types";
import { formatTimeMY } from "@/lib/avsec/datetime";


function formatRoleChip(role: string | null): string | null {
  if (!role) return null;
  const normalized = role.toLowerCase();
  switch (normalized) {
    case "admin":
    case "management":
      return "Management";
    case "enforcement":
      return "Enforcement";
    case "dse":
      return "DSE";
    case "so":
      return "SO";
    case "aso":
      return "ASO";
    case "vendor":
      return "Vendor";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

function todayISODateMY(): string {
  // Mirrors lib/avsec/datetime's MY-local "today" convention (UTC+8), used
  // by the report tables' submitted_at filters this page reuses.
  const now = new Date();
  const my = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return my.toISOString().slice(0, 10);
}


export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Canonical access: the caller's own active Phase 3 assignments decide.
  const activeAssignments = await getActiveRoleAssignments();
  const access = deriveCanonicalAccess(activeAssignments);
  if (access.isSuperAdmin) redirect("/super-admin");

  // External CaterLink identity = the ICMS users-table role (never email/metadata),
  // and only when the account holds no canonical assignment.
  if (!access.hasAssignment) {
    const { data: icmsRow } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
    if (isExternalCaterLinkRole(icmsRow?.role as string | undefined)) redirect("/caterlink/dashboard");
    redirect("/avsec/pending-approval");
  }
  // Canonical roles with no legacy-page rank work through the Phase 7 dashboards.
  if (!access.primaryCompatRole) redirect("/avsec/my-dashboard");

  const { data: avsecProfile } = await supabase.from("profiles").select("name").eq("id", user.id).maybeSingle();
  if (!avsecProfile) redirect("/login?error=no-profile");
  const profile = { name: avsecProfile.name as string };

  const role = (access.primaryCompatRole as string).toLowerCase();
  const orgWide = isOrgWideOperator(access);
  const station = access.stationCode;
  const team = access.teamName;

  // Reports = the existing AVSEC reports app.
  const showReports = true;

  // Scan = the unified checkpoint scan entry point. Canonical station operators
  // (aso/so/sso/dse) whose single assigned station holds the approved CaterLink
  // SCAN capability; leadership never works a checkpoint.
  let canScanHere = false;
  if (isStationOperator(access) && station) {
    const { data: capable } = await supabase.rpc("can_user_scan_caterlink", { p_station_code: station });
    canScanHere = capable === true;
  }
  const showScan = canScanHere && !orgWide;

  const showAdmin = role === "management";
  const showIcmsReports = orgWide;

  // Daily Report (SEC014) filing is ASO-only -- SO/DSE are supervisory roles
  // that acknowledge an ASO's Daily Report instead of filing one.
  const permittedAvsecReports = orgWide
    ? AVSEC_REPORT_TYPES
    : requiresDailyReport(role)
      ? AVSEC_REPORT_TYPES
      : ([] as readonly (typeof AVSEC_REPORT_TYPES)[number][]);

  const roleChip = formatRoleChip(role);

  const currentUserProfile = {
    id: user.id,
    role: role,
    station,
    team,
  };

  const [snapshot, activity, announcements] = await Promise.all([
    getDashboardSnapshot(),
    getActivityFeed(),
    getActiveAnnouncementsForUser(currentUserProfile),
  ]);
  // Phase 7: purely a nav-display decision (see lib/dashboard/navigation.ts).
  const hasPhase7Assignment = activeAssignments.length > 0;

  const overallStatus: OpsStatus =
    snapshot.alerts > 0 ? "critical" : snapshot.activeTransactions > 0 ? "operational" : "standby";

  // Quick-access tile: Bay Board for any canonical station-scoped operator
  // (one operational structure; station decides, not a group).
  let quickAccess: { href: string; label: string; count: number; unit: string } | null = null;
  if (!orgWide && station && isStationOperator(access)) {
    const bay = await getOpenBayBoard(station);
    quickAccess = { href: "/avsec/bay-board", label: "Bay Board", count: bay.length, unit: "aircraft on ground" };
  }

  return (
    <main className="relative min-h-screen bg-background pb-28 lg:pb-8">
      {/* Desktop Persistent Left Sidebar */}
      <AppSidebar
        userId={user.id}
        name={profile.name}
        role={role}
        roleLabel={roleChip}
        canScan={showScan}
        station={station}
        team={team}
        hasPhase7Assignment={hasPhase7Assignment}
        signOutAction={signOut}
      />

      <div className="relative z-10 flex min-h-screen flex-col lg:pl-64">
        {/* Mobile Header (Hidden on Desktop since AppSidebar has brand and user card) */}
        <div className="lg:hidden">
          <UnifiedHeader
            name={profile.name}
            roleLabel={roleChip}
            signOutAction={signOut}
            extra={<NotificationsBell userId={user.id} />}
          />
        </div>

        <div className="flex flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
          {/* Management Announcements Section */}
          <AnnouncementBanner announcements={announcements} />

          {/* Desktop 2-Column Responsive Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Main Operations Stream (8 Columns on Desktop) */}
            <div className="lg:col-span-8 space-y-6">
              {/* Operational status header */}
              <div className="vecta-panel flex flex-wrap items-center justify-between gap-4 px-6 py-5">
                <div className="flex flex-col gap-1.5">
                  <span className="font-display text-lg font-bold tracking-[0.02em]">
                    {station ?? (orgWide ? "All Stations" : "My Workspace")}
                    {team ? ` · Team ${team}` : ""}
                  </span>
                  <StatusDot status={overallStatus} />
                  {!orgWide ? (
                    <Link
                      href="/avsec/duty"
                      className="mt-2 inline-flex items-center justify-between gap-3 rounded-xl bg-primary px-4 py-2.5 font-sans text-xs font-bold tracking-[0.04em] text-primary-foreground shadow-sm transition-all hover:opacity-95 active:scale-[0.98] group"
                    >
                      <span className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-primary-foreground animate-pulse" />
                        <span>DUTY CHECK-IN / CHECK-OUT</span>
                      </span>
                      <span className="font-mono text-sm transition-transform group-hover:translate-x-1 shrink-0">
                        &rarr;
                      </span>
                    </Link>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-6">
                  <Metric label="Staff on Duty" value={snapshot.staffOnDuty} />
                  <Metric label="Active Transactions" value={snapshot.activeTransactions} />
                  <Metric label="Reports Today" value={snapshot.reportsToday} />
                  <Metric
                    label="Alerts"
                    value={snapshot.alerts}
                    alert={snapshot.alerts > 0}
                    href="/avsec/admin/alerts"
                  />
                </div>
              </div>

              {/* Recent activity feed — read-only merge of duty check-in/out,
                  transaction, and report-submission events. */}
              <section className="vecta-panel px-6 py-[22px]">
                <p className="vecta-eyebrow mb-4">Live Activity Stream</p>
                {activity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No recent activity to show.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                          <th className="pb-2 pr-3 font-mono font-medium">Time (MYT)</th>
                          <th className="pb-2 pr-3 font-mono font-medium">Activity</th>
                          <th className="pb-2 pr-3 font-mono font-medium">Location</th>
                          <th className="pb-2 font-mono font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activity.map((row) => (
                          <tr key={row.key} className="border-b border-border/60 last:border-none hover:bg-muted/20 transition-colors">
                            <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-[12px] text-muted-foreground">
                              {formatClock(row.time)}
                            </td>
                            <td className="py-2.5 pr-3 text-[13px]">{row.activity}</td>
                            <td className="py-2.5 pr-3 text-[13px] text-muted-foreground">{row.location}</td>
                            <td className="py-2.5">
                              {row.transactionStatus ? (
                                <TransactionStageBar status={row.transactionStatus} />
                              ) : (
                                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                                  {row.status}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            {/* Quick Actions & Security Reports Hub (4 Columns on Desktop) */}
            <div className="lg:col-span-4 space-y-6">
              {/* Quick Action Tiles */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-3">
                {showScan ? (
                  <Link href="/avsec/scan" className="vecta-tile group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                      <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" stroke="var(--violet)" strokeWidth="1.6" />
                      <rect x="9" y="9" width="6" height="6" stroke="var(--violet)" strokeWidth="1.6" />
                    </svg>
                    <h2 className="font-display text-lg font-bold tracking-[0.03em]">Scan Checkpoint</h2>
                    <p className="vecta-eyebrow mt-0.5">Scan a transaction at your station</p>
                  </Link>
                ) : orgWide ? (
                  <Link href="/avsec/reports/lookup" className="vecta-tile group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                      <circle cx="10.5" cy="10.5" r="6" stroke="var(--violet)" strokeWidth="1.6" />
                      <path d="M15 15L20 20" stroke="var(--violet)" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                    <h2 className="font-display text-lg font-bold tracking-[0.03em]">Report Search</h2>
                    <p className="vecta-eyebrow mt-0.5">Look up any report · org-wide</p>
                  </Link>
                ) : null}

                {quickAccess && (
                  <Link href={quickAccess.href} className="vecta-tile group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                      <path d="M4 19h16M6 19V9l6-4 6 4v10" stroke="var(--cyan)" strokeWidth="1.6" />
                    </svg>
                    <h2 className="font-display text-lg font-bold tracking-[0.03em]">{quickAccess.label}</h2>
                    <p className="vecta-eyebrow mt-0.5 font-mono text-[13px] normal-case tracking-normal text-foreground">
                      {quickAccess.count} {quickAccess.unit}
                    </p>
                  </Link>
                )}

                {showAdmin && (
                  <>
                    <Link href="/avsec/admin/attendance-monitor" className="vecta-tile group">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" stroke="var(--cyan)" strokeWidth="1.6" />
                        <rect x="9" y="3" width="6" height="4" rx="2" stroke="var(--cyan)" strokeWidth="1.6" />
                        <path d="M9 14l2 2 4-4" stroke="var(--cyan)" strokeWidth="1.6" />
                      </svg>
                      <h2 className="font-display text-lg font-bold tracking-[0.03em]">Attendance Monitor</h2>
                      <p className="vecta-eyebrow mt-0.5">Live duty, leave & auto-OT</p>
                    </Link>
                    <Link href="/avsec/management/feedback" className="vecta-tile group">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="var(--cyan)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <h2 className="font-display text-lg font-bold tracking-[0.03em]">Feedback Inbox</h2>
                      <p className="vecta-eyebrow mt-0.5">Anonymous staff feedback</p>
                    </Link>
                    <Link href="/avsec/management/announcements" className="vecta-tile group">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke="var(--cyan)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke="var(--cyan)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <h2 className="font-display text-lg font-bold tracking-[0.03em]">Announcements</h2>
                      <p className="vecta-eyebrow mt-0.5">Broadcast to staff & teams</p>
                    </Link>
                  </>
                )}
                {!showAdmin && (
                  <Link href="/avsec/feedback" className="vecta-tile group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-2" aria-hidden="true">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="var(--cyan)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <h2 className="font-display text-lg font-bold tracking-[0.03em]">Staff Feedback</h2>
                    <p className="vecta-eyebrow mt-0.5">Submit anonymous feedback</p>
                  </Link>
                )}
              </div>

              {/* Reports section */}
              {(showReports || showIcmsReports) && (
                <section id="reports" className="vecta-panel px-5 py-5 scroll-mt-24">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="vecta-eyebrow">File Reports</p>
                    {showReports && (
                      <Link href="/avsec/history" className="font-mono text-[10px] uppercase tracking-[0.1em] text-primary hover:underline">
                        History &rarr;
                      </Link>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {showReports &&
                      permittedAvsecReports.map((t) => (
                        <Link
                          key={t}
                          href={`/avsec/reports/${t}`}
                          className="rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-primary"
                        >
                          <p className="font-mono text-[9px] text-muted-foreground">{REPORT_META[t].code}</p>
                          <p className="mt-0.5 text-xs font-semibold leading-tight line-clamp-1">{REPORT_META[t].name}</p>
                        </Link>
                      ))}
                    {showIcmsReports && (
                      <Link
                        href="/icms/reports"
                        className="rounded-lg border border-border bg-card p-2.5 transition-colors hover:border-primary col-span-2"
                      >
                        <p className="font-mono text-[9px] text-muted-foreground">ICMS</p>
                        <p className="mt-0.5 text-xs font-semibold leading-tight">
                          Transaction &amp; Incident Reports
                        </p>
                      </Link>
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>

      <TeamBottomNav orgWide={orgWide} role={role} canScan={showScan} hasPhase7Assignment={hasPhase7Assignment} />
    </main>
  );
}

function Metric({
  label,
  value,
  alert,
  href,
}: {
  label: string;
  value: number;
  alert?: boolean;
  /** When set, the metric becomes a link — used for Alerts so the count
   *  isn't a dead end (it used to be a static number with no way to see
   *  what the alerts actually were). */
  href?: string;
}) {
  const content = (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="font-mono text-2xl font-semibold tabular-nums"
        style={{ color: alert ? "var(--red)" : undefined }}
      >
        {String(value).padStart(2, "0")}
      </span>
      <span className="vecta-eyebrow">{label}</span>
    </div>
  );
  if (!href) return content;
  return (
    <Link href={href} className="rounded-md transition-opacity hover:opacity-75">
      {content}
    </Link>
  );
}

function formatClock(iso: string): string {
  // Was `.toLocaleTimeString()` with no timezone — on Vercel's UTC server that
  // rendered raw UTC (e.g. 04:57) while every other view (formatTimeMY) already
  // converts to Asia/Kuala_Lumpur (e.g. 12:57 for the same instant), an 8-hour
  // discrepancy for the exact same check-in event. Use the same MY-local
  // formatter everywhere, with an explicit "MYT" label so it's unambiguous.
  return formatTimeMY(iso);
}

interface DashboardSnapshot {
  staffOnDuty: number;
  activeTransactions: number;
  reportsToday: number;
  alerts: number;
}

/**
 * Read-only aggregation for the status header's compact counts. Reuses the
 * exact tables already backing ICMS's dashboard-charts.tsx (transactions,
 * incidents) and AVSEC's dashboard (duty_records, the report_sec0xx
 * tables) — no new tables, no write paths touched.
 */
async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const supabase = await createClient();
  const todayMY = todayISODateMY();

  const [dutyRes, txRes, incidentsRes, bayRes, ...reportCounts] = await Promise.all([
    supabase
      .from("duty_records")
      .select("profile_id")
      .eq("duty_date", todayMY)
      .not("check_in_at", "is", null)
      .is("check_out_at", null)
      .limit(1000),
    supabase
      .from("transactions")
      .select("status, direction, route")
      .not("status", "in", "(COMPLETED,ESCALATED)")
      .limit(500),
    supabase
      .from("incidents")
      .select("id")
      .is("resolved_at", null)
      .limit(500),
    getOpenBayBoard(),
    ...AVSEC_REPORT_TYPES.map((t) =>
      supabase
        .from(REPORT_META[t].table as never)
        .select("id", { count: "exact", head: true })
        .eq("status", "submitted")
        .gte("submitted_at", `${todayMY}T00:00:00+08:00`)
        .lte("submitted_at", `${todayMY}T23:59:59.999+08:00`)
    ),
  ]);

  const staffOnDuty = (dutyRes.data ?? []).length;
  const activeTransactions = (txRes.data ?? []).length;
  const overdueBays = (bayRes ?? []).filter((b) => b.hoursOnGround >= 4).length;
  const openIncidents = (incidentsRes.data ?? []).length;
  const alerts = overdueBays + openIncidents;

  // Visibility of every count below is enforced by RLS / canonical scope, not by a group filter.
  const reportsToday = reportCounts.reduce((sum, r) => sum + (r.count ?? 0), 0);

  return { staffOnDuty, activeTransactions, reportsToday, alerts };
}

interface ActivityRow {
  key: string;
  time: string;
  activity: string;
  location: string;
  status: string;
  transactionStatus?: TransactionStatus;
}

/**
 * Read-only merge-sort of three existing event sources into one feed — new
 * query composition, but no mutation logic. Capped to the 20 most recent.
 */
async function getActivityFeed(): Promise<ActivityRow[]> {
  const supabase = await createClient();
  const todayMY = todayISODateMY();

  const [dutyRes, txRes, submissions, incidentsRes] = await Promise.all([
    supabase
      .from("duty_records")
      .select("check_in_at, check_out_at, profiles(name, station)")
      .eq("duty_date", todayMY)
      .order("check_in_at", { ascending: false })
      .limit(20),
    supabase
      .from("transactions")
      .select("transaction_number, status, direction, route, created_at, completed_at")
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(20),
    getFilteredSubmissions({ dateFrom: todayMY, dateTo: todayMY }).catch(() => []),
    // Same source as the "alerts" tile in getDashboardSnapshot — open
    // incidents were previously counted in alerts but never shown here,
    // which is what let a scoped dashboard show alerts with an empty feed.
    supabase
      .from("incidents")
      .select("id, incident_type, created_at, transactions(transaction_number)")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const rows: ActivityRow[] = [];

  const dutyRows = (dutyRes.data ?? []) as {
    check_in_at: string | null;
    check_out_at: string | null;
    profiles: { name: string; station: string | null } | null;
  }[];
  for (const d of dutyRows) {
    if (d.check_out_at) {
      rows.push({
        key: `duty-out-${d.check_out_at}-${d.profiles?.name}`,
        time: d.check_out_at,
        activity: `${d.profiles?.name ?? "Officer"} checked out`,
        location: d.profiles?.station ?? "—",
        status: "CHECKED OUT",
      });
    } else if (d.check_in_at) {
      rows.push({
        key: `duty-in-${d.check_in_at}-${d.profiles?.name}`,
        time: d.check_in_at,
        activity: `${d.profiles?.name ?? "Officer"} checked in`,
        location: d.profiles?.station ?? "—",
        status: "ON DUTY",
      });
    }
  }

  const txRows = (txRes.data ?? []) as {
    transaction_number: string;
    status: TransactionStatus;
    direction: Direction;
    route: TransactionRoute;
    created_at: string;
    completed_at: string | null;
  }[];
  for (const t of txRows) {
    const time = t.completed_at ?? t.created_at;
    rows.push({
      key: `tx-${t.transaction_number}-${time}`,
      time,
      activity: `${t.transaction_number} · ${t.direction === "OUTBOUND" ? "Outbound" : "Inbound"} movement`,
      location: t.route,
      status: t.status,
      transactionStatus: t.status,
    });
  }

  for (const s of submissions) {
    if (!s.submitted_at) continue;
    rows.push({
      key: `report-${s.type}-${s.id}`,
      time: s.submitted_at,
      activity: `${REPORT_META[s.type].code} submitted — ${s.summary}`,
      location: [s.station, s.team].filter(Boolean).join(" · ") || "—",
      status: "SUBMITTED",
    });
  }

  const incidentRows = (incidentsRes.data ?? []) as {
    id: string;
    incident_type: string;
    created_at: string;
    transactions: { transaction_number: string } | null;
  }[];
  for (const inc of incidentRows) {
    rows.push({
      key: `incident-${inc.id}`,
      time: inc.created_at,
      activity: `Incident — ${inc.incident_type}${inc.transactions ? ` (${inc.transactions.transaction_number})` : ""}`,
      location: "—",
      status: "OPEN",
    });
  }

  rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return rows.slice(0, 20);
}
