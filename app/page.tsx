import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/lib/avsec/profile-actions";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { getAllowedReportForms } from "@/lib/avsec/reports/form-capability";
import { getMyRecentActivity, getStationActivity } from "@/lib/avsec/dashboard/activity-queries";
import { ReportCategoryGroups } from "@/components/avsec/reports/ReportCategoryGroups";
import { REPORT_TYPES as AVSEC_REPORT_TYPES, REPORT_META } from "@/lib/avsec/reference-data";
import { StatusDot, type OpsStatus } from "@/components/layout/StatusDot";
import { AppChrome } from "@/components/layout/shell/AppChrome";
import { ActionCard, OperationalSummaryCard, PageHeader, RoleScopeHeader } from "@/components/ds/cards";
import { CalendarCheck, Megaphone, Plane, ScanLine, Search } from "lucide-react";
import { buildNavModel } from "@/lib/dashboard/nav-capabilities";
import { getCanConfirmCaterLinkReceipt } from "@/lib/avsec/caterlink/receipt-capability";
import { landsOnRoleDashboard, primaryRoleLabel } from "@/lib/auth/role-capabilities";
import { TransactionStageBar } from "@/components/layout/TransactionStageBar";
import { getActiveAnnouncementsForUser } from "@/lib/avsec/announcements/queries";
import { getActiveRoleAssignments } from "@/lib/dashboard/context";
import { deriveCanonicalAccess, isOrgWideOperator } from "@/lib/auth/canonical-access";
import { todayISODateMY } from "@/lib/avsec/datetime";
import { isStationOperator } from "@/lib/icms/canonical";
import { classifyPortalAccess, isCaterLinkOnly } from "@/lib/auth/caterlink-access";
import { AnnouncementBanner } from "@/components/avsec/announcements/AnnouncementBanner";
import type { TransactionStatus } from "@/lib/icms/database.types";
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

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Canonical access: the caller's own active Phase 3 assignments decide.
  const activeAssignments = await getActiveRoleAssignments();
  const access = deriveCanonicalAccess(activeAssignments);
  // One portal decision (lib/auth/caterlink-access.ts): trusted assignments + the trusted account row; never
  // email or metadata. CaterLink Management / Driver / Vendor see only CaterLink; mixed or non-active
  // identities fail closed.
  const { data: portalRow } = await supabase.from("users").select("role, status").eq("id", user.id).maybeSingle();
  const portal = classifyPortalAccess(access, portalRow);
  if (portal.kind === "conflict") redirect("/login?error=conflicting-access");
  if (portal.kind === "blocked") redirect(`/login?error=${encodeURIComponent(portal.status ?? "pending")}`);
  if (isCaterLinkOnly(portal.kind)) redirect("/caterlink/dashboard");
  if (access.isSuperAdmin) redirect("/super-admin");
  if (!access.hasAssignment) redirect("/avsec/pending-approval");
  // Canonical roles with no legacy-page rank work through the Phase 7 dashboards.
  if (!access.primaryCompatRole || landsOnRoleDashboard(access.roleCodes)) redirect("/avsec/my-dashboard");

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

  // Which forms may be FILED is the database's decision (report_form_assignments via list_my_report_forms_secure), the same source the
  // submit actions and the table triggers use. Daily Report Profiling (SEC013) is therefore shown only to an assigned Profiling ASO,
  // and supervisory roles that acknowledge reports instead of filing them see no filing cards.
  const allowedForms = await getAllowedReportForms();

  const roleChip = primaryRoleLabel(access.roleCodes) ?? formatRoleChip(role);

  const currentUserProfile = {
    id: user.id,
    role: role,
    station,
    team,
  };

  const [snapshot, myActivity, stationActivity, announcements] = await Promise.all([
    getDashboardSnapshot(),
    getMyRecentActivity(user.id),
    getStationActivity(station),
    getActiveAnnouncementsForUser(currentUserProfile),
  ]);
  // Both feeds are read once when the page renders; say when, so a snapshot is never mistaken for a live stream.
  const loadedAt = formatTimeMY(new Date().toISOString());
  // Navigation is display-only and comes from the caller's canonical roles plus the two server-derived station capabilities.
  const canReceive = await getCanConfirmCaterLinkReceipt(access);
  const navModel = buildNavModel({ roleCodes: access.roleCodes, canScan: showScan, canReceive });

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
    <main className="relative min-h-screen bg-background">
      <AppChrome userId={user.id} name={profile.name} roleLabel={roleChip} model={navModel} station={station} team={team} signOutAction={signOut}>
        <div className="flex flex-col gap-6 px-4 py-5 sm:px-8 sm:py-8">
          <PageHeader
            title="My Workspace"
            eyebrow={station ?? (orgWide ? "All stations" : undefined)}
            actions={
              !orgWide ? (
                <Link
                  href="/avsec/duty"
                  className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-brand px-5 text-sm font-bold text-brand-foreground shadow-sm transition-opacity hover:opacity-90"
                >
                  <span className="h-2 w-2 rounded-full bg-brand-foreground" aria-hidden />
                  Duty check-in / check-out
                </Link>
              ) : null
            }
          />
          <div className="flex flex-wrap items-center gap-3">
            <RoleScopeHeader
              roleLabel={roleChip}
              scopes={[...(station ? [{ label: "Station", value: station }] : []), ...(team ? [{ label: "Team", value: team }] : [])]}
            />
            <StatusDot status={overallStatus} />
          </div>

          {/* Management Announcements Section */}
          <AnnouncementBanner announcements={announcements} />

          <section aria-label="Operational summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <OperationalSummaryCard label="Staff on duty" value={snapshot.staffOnDuty} />
            <OperationalSummaryCard label="Active transactions" value={snapshot.activeTransactions} />
            <OperationalSummaryCard label="Reports today" value={snapshot.reportsToday} />
            <OperationalSummaryCard label="Alerts" value={snapshot.alerts} tone={snapshot.alerts > 0 ? "danger" : "success"} href="/avsec/admin/alerts" />
          </section>

          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
            <div className="space-y-6 lg:col-span-8">
              {/* My recent activity: ONLY actions the signed-in officer performed (actor-scoped in the query itself). */}
              <section className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] sm:p-5" aria-labelledby="my-activity-heading" data-activity-feed="mine">
                <h2 id="my-activity-heading" className="text-base font-semibold text-foreground">
                  My Recent Activity
                </h2>
                <p className="mb-3 text-xs text-muted-foreground">What you did in the last 7 days. Records visible to you that someone else created are not listed here.</p>
                {myActivity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">You have no recorded actions in the last 7 days.</p>
                ) : (
                  <>
                    <ul className="space-y-2 md:hidden">
                      {myActivity.map((row) => (
                        <li key={row.key} className="rounded-lg border border-border bg-background p-3">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-medium text-foreground">{row.activity}</p>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatClock(row.time)}</span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span>{row.reference ?? "—"}</span>
                            <span className="font-semibold uppercase tracking-wide">{row.status}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="hidden md:block">
                      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="My recent activity (scrollable)">
                        <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-border text-xs text-muted-foreground">
                              <th scope="col" className="pb-2 pr-3 font-semibold">Time (MYT)</th>
                              <th scope="col" className="pb-2 pr-3 font-semibold">What I did</th>
                              <th scope="col" className="pb-2 pr-3 font-semibold">Reference</th>
                              <th scope="col" className="pb-2 font-semibold">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {myActivity.map((row) => (
                              <tr key={row.key} className="border-b border-border/60 transition-colors last:border-none hover:bg-muted/40">
                                <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-xs text-muted-foreground">{formatClock(row.time)}</td>
                                <td className="py-2.5 pr-3 text-sm">{row.activity}</td>
                                <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">{row.reference ?? "—"}</td>
                                <td className="py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{row.status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </section>

              {/* Station activity: operational records this role may read, scoped to the officer's own station. A snapshot, not a live stream. */}
              <section className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)] sm:p-5" aria-labelledby="station-activity-heading" data-activity-feed="station">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="station-activity-heading" className="text-base font-semibold text-foreground">
                    {station ? `Station Activity · ${station}` : "Station Activity · all authorised stations"}
                  </h2>
                  <Link href="/" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-primary hover:underline">
                    Refresh
                  </Link>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">Loaded at {loadedAt} MYT when this page opened. It does not update by itself; use Refresh.</p>
                {stationActivity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No station activity to show for today.</p>
                ) : (
                  <>
                    <ul className="space-y-2 md:hidden">
                      {stationActivity.map((row) => (
                        <li key={row.key} className="rounded-lg border border-border bg-background p-3">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-medium text-foreground">{row.activity}</p>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatClock(row.time)}</span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span>
                              {row.route ? `Route: ${row.route}` : null}
                              {row.route && row.location ? " · " : null}
                              {row.location ? `Station: ${row.location}` : null}
                              {!row.route && !row.location ? "—" : null}
                            </span>
                            {row.transactionStatus ? (
                              <TransactionStageBar status={row.transactionStatus as TransactionStatus} />
                            ) : (
                              <span className="font-semibold uppercase tracking-wide">{row.status}</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="hidden md:block">
                      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Station activity (scrollable)">
                        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-border text-xs text-muted-foreground">
                              <th scope="col" className="pb-2 pr-3 font-semibold">Time (MYT)</th>
                              <th scope="col" className="pb-2 pr-3 font-semibold">Activity</th>
                              <th scope="col" className="pb-2 pr-3 font-semibold">Route</th>
                              <th scope="col" className="pb-2 pr-3 font-semibold">Station/Location</th>
                              <th scope="col" className="pb-2 font-semibold">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stationActivity.map((row) => (
                              <tr key={row.key} className="border-b border-border/60 transition-colors last:border-none hover:bg-muted/40">
                                <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-xs text-muted-foreground">{formatClock(row.time)}</td>
                                <td className="py-2.5 pr-3 text-sm">{row.activity}</td>
                                <td className="py-2.5 pr-3 text-sm text-muted-foreground">{row.route ?? "—"}</td>
                                <td className="py-2.5 pr-3 text-sm text-muted-foreground">{row.location ?? "—"}</td>
                                <td className="py-2.5">
                                  {row.transactionStatus ? (
                                    <TransactionStageBar status={row.transactionStatus as TransactionStatus} />
                                  ) : (
                                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{row.status}</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>

            <div className="space-y-6 lg:col-span-4">
              {/* Quick actions: each link is shown only when the server-derived capability allows it */}
              <section aria-label="Quick actions" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {showScan ? (
                  <ActionCard href="/avsec/scan" title="Scan Checkpoint" description="Scan a transaction at your station" icon={<ScanLine className="h-5 w-5" />} />
                ) : orgWide ? (
                  <ActionCard href="/avsec/reports/lookup" title="Report Search" description="Look up any report · org-wide" icon={<Search className="h-5 w-5" />} />
                ) : null}
                {quickAccess ? (
                  <ActionCard
                    href={quickAccess.href}
                    title={quickAccess.label}
                    description={`${quickAccess.count} ${quickAccess.unit}`}
                    icon={<Plane className="h-5 w-5" />}
                  />
                ) : null}
                {showAdmin ? (
                  <>
                    <ActionCard href="/avsec/admin/attendance-monitor" title="Attendance Monitor" description="Live duty, leave & auto-OT" icon={<CalendarCheck className="h-5 w-5" />} />
                    <ActionCard href="/avsec/management/announcements" title="Announcements" description="Broadcast to staff & teams" icon={<Megaphone className="h-5 w-5" />} />
                  </>
                ) : null}
              </section>

              {/* Reports section */}
              {(showReports || showIcmsReports) && (
                <section id="reports" className="scroll-mt-24 rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]" aria-labelledby="reports-heading">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 id="reports-heading" className="text-base font-semibold text-foreground">
                      Security Reports
                    </h2>
                    {showReports && (
                      <Link href="/avsec/history" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-primary hover:underline">
                        History &rarr;
                      </Link>
                    )}
                  </div>
                  {showReports && <ReportCategoryGroups allowed={allowedForms} layout="grid" />}
                  {showIcmsReports && (
                    <Link href="/icms/reports" className="mt-3 flex min-h-[56px] flex-col justify-center rounded-lg border border-border bg-background p-2.5 transition-colors hover:border-primary">
                      <span className="font-mono text-xs text-muted-foreground">ICMS</span>
                      <span className="mt-0.5 text-sm font-semibold leading-tight text-foreground">Transaction &amp; Incident Reports</span>
                    </Link>
                  )}
                </section>
              )}
            </div>
          </div>
        </div>
      </AppChrome>
    </main>
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
      .from("caterlink_incidents" as never)
      .select("id")
      .in("status", ["OPEN", "UNDER_REVIEW"])
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
