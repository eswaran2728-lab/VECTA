import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth/guards";
import { signOut } from "@/lib/avsec/profile-actions";
import { opsGroupForTransaction } from "@/lib/icms/ops-group";
import { getFilteredSubmissions } from "@/lib/avsec/dashboard/queries";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { REPORT_TYPES as AVSEC_REPORT_TYPES, REPORT_META } from "@/lib/avsec/reference-data";
import { StatusDot, type OpsStatus } from "@/components/layout/StatusDot";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { TransactionStageBar } from "@/components/layout/TransactionStageBar";
import type { Direction, OpsGroup, TransactionRoute, TransactionStatus } from "@/lib/icms/database.types";

// Unified role vocabulary (supabase/migrations/unified_role_model):
// admin, management, enforcement, so, aso, dse. Org-wide roles
// (admin/management/enforcement) get both apps and see all 3 ops_groups;
// so/aso/dse get whichever app their account actually lives in
// (public.profiles for AVSEC-origin, public.users for ICMS-origin) — a
// bare "aso" mapping doesn't by itself grant ICMS RLS access, since that's
// keyed off having an actual public.users row, not just the unified_role
// string.
const ORG_WIDE_ROLES = ["admin", "management", "enforcement"];

const OPS_GROUPS: OpsGroup[] = ["operation_avsec", "ifc_avsec", "hub_avsec"];
const OPS_GROUP_LABELS: Record<OpsGroup, string> = {
  operation_avsec: "Operation AVSEC",
  ifc_avsec: "IFC AVSEC",
  hub_avsec: "Hub AVSEC",
};

function todayISODateMY(): string {
  // Mirrors lib/avsec/datetime's MY-local "today" convention (UTC+8), used
  // by the report tables' submitted_at filters this page reuses.
  const now = new Date();
  const my = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return my.toISOString().slice(0, 10);
}

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ ops?: string }>;
}) {
  const { ops } = await searchParams;
  const user = await getAuthUser();
  if (!user) redirect("/login");
  const supabase = await createClient();

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase
      .from("profiles")
      .select("unified_role, name, role, ops_group, station, team")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("users")
      .select("unified_role, name, role, ops_group")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  const profile = avsecProfile ?? icmsProfile;
  if (!profile) redirect("/login?error=no-profile");

  const role = profile.unified_role as string | null;
  const orgWide = role ? ORG_WIDE_ROLES.includes(role) : false;

  // Reports = the existing (unchanged) AVSEC reports app — only reachable
  // by accounts that actually have an AVSEC profile row, or org-wide roles
  // (who see every team's reports regardless of origin).
  const showReports = Boolean(avsecProfile) || orgWide;

  // Scan = the unified checkpoint scan entry point — not applicable to
  // org-wide roles (Management/Enforcement/Admin never work a checkpoint
  // themselves); they get Report Search instead, both here and in
  // TeamBottomNav.
  const userOpsGroup = (profile.ops_group ?? null) as OpsGroup | null;
  const showScan = Boolean(userOpsGroup) && !orgWide;

  const showAdmin = role === "admin";
  const showIcmsReports = Boolean(
    icmsProfile && ["supervisor", "enforcement", "management"].includes(icmsProfile.role ?? "")
  ) || orgWide;

  const activeTab: OpsGroup | "all" = orgWide && ops && OPS_GROUPS.includes(ops as OpsGroup) ? (ops as OpsGroup) : "all";
  // Effective ops_group scope for header counts / activity feed: the
  // org-wide filter tab when present, otherwise the signed-in user's own
  // ops_group (or "all" for an org-wide viewer who hasn't picked a tab).
  const scopeGroup: OpsGroup | "all" = orgWide ? activeTab : (userOpsGroup ?? "all");

  const opsSummary = orgWide ? await getOpsGroupSummary(activeTab) : null;

  const roleChip = role ? role.charAt(0).toUpperCase() + role.slice(1) : null;
  const maxCount = opsSummary && opsSummary.length > 0 ? Math.max(1, ...opsSummary.map((r) => r.count)) : 1;

  const [snapshot, activity] = await Promise.all([
    getDashboardSnapshot(scopeGroup),
    getActivityFeed(scopeGroup),
  ]);

  const overallStatus: OpsStatus =
    snapshot.alerts > 0 ? "critical" : snapshot.activeTransactions > 0 ? "operational" : "standby";

  // Quick-access tile: Bay Board for operation_avsec/hub_avsec, Transaction
  // History for ifc_avsec — an in-addition-to-the-bottom-nav shortcut card.
  // Only shown for team-scoped (non-org-wide) viewers with a real station
  // (Bay Board is station-scoped; org-wide viewers already get the full ops
  // summary panel below instead).
  let quickAccess: { href: string; label: string; count: number; unit: string } | null = null;
  if (!orgWide && avsecProfile?.station) {
    if (userOpsGroup === "operation_avsec" || userOpsGroup === "hub_avsec") {
      const bay = await getOpenBayBoard(avsecProfile.station);
      quickAccess = { href: "/avsec/bay-board", label: "Bay Board", count: bay.length, unit: "aircraft on ground" };
    } else if (userOpsGroup === "ifc_avsec") {
      quickAccess = {
        href: "/icms/transactions",
        label: "Transaction History",
        count: snapshot.activeTransactions,
        unit: "active transactions",
      };
    }
  }

  return (
    <main className="relative min-h-screen bg-background pb-28">
      <div className="relative z-10 flex min-h-screen flex-col">
        <UnifiedHeader name={profile.name} roleLabel={roleChip} signOutAction={signOut} />

        <div className="flex flex-col gap-6 px-8 py-8">
          {/* Operational status header */}
          <div className="vecta-panel flex flex-wrap items-center justify-between gap-4 px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <span className="font-display text-lg font-bold tracking-[0.02em]">
                {avsecProfile?.station ?? (orgWide ? "All Stations" : OPS_GROUP_LABELS[userOpsGroup ?? "ifc_avsec"])}
                {avsecProfile?.team ? ` · Team ${avsecProfile.team}` : ""}
              </span>
              <StatusDot status={overallStatus} />
              {!orgWide && avsecProfile ? (
                <Link
                  href="/avsec/duty"
                  className="font-mono text-[11px] uppercase tracking-[0.08em] text-primary underline underline-offset-4"
                >
                  Duty Check-In / Check-Out &rarr;
                </Link>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-6">
              <Metric label="Staff on Duty" value={snapshot.staffOnDuty} />
              <Metric label="Active Transactions" value={snapshot.activeTransactions} />
              <Metric label="Reports Today" value={snapshot.reportsToday} />
              <Metric label="Alerts" value={snapshot.alerts} alert={snapshot.alerts > 0} />
            </div>
          </div>

          {orgWide ? (
            <div className="vecta-pill-tabs w-fit">
              <TabPill label="All Ops Groups" active={activeTab === "all"} href="/" />
              {OPS_GROUPS.map((g) => (
                <TabPill key={g} label={OPS_GROUP_LABELS[g]} active={activeTab === g} href={`/?ops=${g}`} />
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row">
            {showScan ? (
              <Link href="/avsec/scan" className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" stroke="var(--violet)" strokeWidth="1.6" />
                  <rect x="9" y="9" width="6" height="6" stroke="var(--violet)" strokeWidth="1.6" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">Scan</h2>
                <p className="vecta-eyebrow mt-1">Scan a transaction in your ops group</p>
              </Link>
            ) : orgWide ? (
              // Management/Enforcement/Admin don't work a checkpoint, so
              // Scan doesn't apply to them — Report Search instead, same
              // swap as the bottom nav (TeamBottomNav.tsx).
              <Link href="/avsec/reports/lookup" className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6" stroke="var(--violet)" strokeWidth="1.6" />
                  <path d="M15 15L20 20" stroke="var(--violet)" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">Report Search</h2>
                <p className="vecta-eyebrow mt-1">Look up any report · org-wide</p>
              </Link>
            ) : null}
            {quickAccess && (
              <Link href={quickAccess.href} className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <path d="M4 19h16M6 19V9l6-4 6 4v10" stroke="var(--cyan)" strokeWidth="1.6" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">{quickAccess.label}</h2>
                <p className="vecta-eyebrow mt-1 font-mono text-[13px] normal-case tracking-normal text-foreground">
                  {quickAccess.count} {quickAccess.unit}
                </p>
              </Link>
            )}
            {showAdmin && (
              <Link href="/avsec/admin/users" className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <circle cx="12" cy="8" r="3.4" stroke="var(--cyan)" strokeWidth="1.6" />
                  <path d="M5 20c0-3.6 3-6 7-6s7 2.4 7 6" stroke="var(--cyan)" strokeWidth="1.6" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">Admin</h2>
                <p className="vecta-eyebrow mt-1">Users, whitelists, audit</p>
              </Link>
            )}
          </div>

          {orgWide && opsSummary ? (
            <div className="vecta-panel px-6 py-[22px]">
              <p className="vecta-eyebrow mb-4">
                {activeTab === "all"
                  ? "Open Transactions — All Ops Groups"
                  : `Open Transactions — ${OPS_GROUP_LABELS[activeTab]}`}
              </p>
              {opsSummary.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open transactions right now.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {opsSummary.map((row) => {
                    const clear = row.count === 0;
                    return (
                      <div key={row.group} className="flex items-center gap-3.5">
                        <span
                          className="h-[6px] w-[6px] shrink-0 rounded-full"
                          style={{ background: clear ? "var(--green)" : "var(--cyan)" }}
                        />
                        <span className="w-[150px] shrink-0 text-sm">{OPS_GROUP_LABELS[row.group]}</span>
                        <div className="h-[6px] flex-1 rounded-full bg-input">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(clear ? 4 : 0, (row.count / maxCount) * 100)}%`,
                              background: clear ? "var(--green)" : "var(--cyan)",
                            }}
                          />
                        </div>
                        <span className="w-[34px] shrink-0 text-right font-mono text-[15px] font-medium">
                          {String(row.count).padStart(2, "0")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* Reports section — merged AVSEC (6 SEC0xx + offload) and ICMS
              report entry points into one surface. Same reports, same
              submission/review logic; purely surfaced from one place. */}
          {(showReports || showIcmsReports) && (
            <section id="reports" className="vecta-panel px-6 py-[22px] scroll-mt-24">
              <div className="mb-4 flex items-center justify-between">
                <p className="vecta-eyebrow">Reports</p>
                {showReports && (
                  <Link href="/avsec/history" className="font-mono text-[11px] uppercase tracking-[0.1em] text-primary">
                    My Submissions &rarr;
                  </Link>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {showReports &&
                  AVSEC_REPORT_TYPES.map((t) => (
                    <Link
                      key={t}
                      href={`/avsec/reports/${t}`}
                      className="rounded-xl border border-border bg-card px-3.5 py-3 transition-colors hover:border-primary"
                    >
                      <p className="font-mono text-[10px] text-muted-foreground">{REPORT_META[t].code}</p>
                      <p className="mt-1 text-[13px] font-semibold leading-snug">{REPORT_META[t].name}</p>
                    </Link>
                  ))}
                {showIcmsReports && (
                  <Link
                    href="/icms/reports"
                    className="rounded-xl border border-border bg-card px-3.5 py-3 transition-colors hover:border-primary"
                  >
                    <p className="font-mono text-[10px] text-muted-foreground">ICMS</p>
                    <p className="mt-1 text-[13px] font-semibold leading-snug">
                      Transaction &amp; Incident Reports
                    </p>
                  </Link>
                )}
              </div>
            </section>
          )}

          {/* Recent activity feed — read-only merge of duty check-in/out,
              transaction, and report-submission events. */}
          <section className="vecta-panel px-6 py-[22px]">
            <p className="vecta-eyebrow mb-4">Recent Activity</p>
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity to show.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      <th className="pb-2 pr-3 font-mono font-medium">Time</th>
                      <th className="pb-2 pr-3 font-mono font-medium">Activity</th>
                      <th className="pb-2 pr-3 font-mono font-medium">Location</th>
                      <th className="pb-2 font-mono font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((row) => (
                      <tr key={row.key} className="border-b border-border/60 last:border-none">
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
      </div>

      <TeamBottomNav opsGroup={userOpsGroup} orgWide={orgWide} />
    </main>
  );
}

function Metric({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
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
}

function TabPill({ label, active, href }: { label: string; active: boolean; href: string }) {
  return (
    <Link href={href} className={`vecta-pill${active ? " is-active" : ""}`}>
      {label}
    </Link>
  );
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Lightweight scan-activity summary for the admin/management/enforcement
 * dashboard — a proportionate stand-in for a real analytics view, not a
 * reimplementation of Reports (those stay on the unchanged /avsec/dashboard
 * page). Counts in-progress ICMS transactions, bucketed by the ops_group
 * their current checkpoint maps to (lib/icms/ops-group.ts) — the same
 * mapping the Scan feature's server-side check enforces.
 */
async function getOpsGroupSummary(
  filter: OpsGroup | "all"
): Promise<{ group: OpsGroup; count: number }[]> {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("transactions")
    .select("status, direction, route")
    .not("status", "in", "(COMPLETED,ESCALATED)")
    .limit(500);

  const counts: Record<OpsGroup, number> = { operation_avsec: 0, ifc_avsec: 0, hub_avsec: 0 };
  for (const row of rows ?? []) {
    const group = opsGroupForTransaction(
      row.direction as Direction,
      row.status as TransactionStatus,
      row.route as TransactionRoute
    );
    if (group) counts[group] += 1;
  }

  const groups = filter === "all" ? OPS_GROUPS : [filter];
  return groups.map((g) => ({ group: g, count: counts[g] }));
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
async function getDashboardSnapshot(scopeGroup: OpsGroup | "all"): Promise<DashboardSnapshot> {
  const supabase = await createClient();
  const todayMY = todayISODateMY();

  const [dutyRes, txRes, incidentsRes, bayRes, ...reportCounts] = await Promise.all([
    supabase
      .from("duty_records")
      .select("profile_id, profiles(ops_group)")
      .eq("duty_date", todayMY)
      .not("check_in_at", "is", null)
      .is("check_out_at", null)
      .limit(1000),
    supabase
      .from("transactions")
      .select("status, direction, route")
      .not("status", "in", "(COMPLETED,ESCALATED)")
      .limit(500),
    // Joined to transactions so incidents can be scoped by ops_group the
    // same way transactions are (incidents have no ops_group of their own —
    // they hang off a transaction_id).
    supabase
      .from("incidents")
      .select("id, transactions(status, direction, route)")
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

  const dutyRows = (dutyRes.data ?? []) as { profile_id: string; profiles: { ops_group: OpsGroup | null } | null }[];
  const staffOnDuty =
    scopeGroup === "all" ? dutyRows.length : dutyRows.filter((r) => r.profiles?.ops_group === scopeGroup).length;

  const txRows = (txRes.data ?? []) as { status: TransactionStatus; direction: Direction; route: TransactionRoute }[];
  const activeTransactions =
    scopeGroup === "all"
      ? txRows.length
      : txRows.filter((r) => opsGroupForTransaction(r.direction, r.status, r.route) === scopeGroup).length;

  // Bay board is a Hub AVSEC-only concept (aircraft on ground) — only count
  // overdue bays toward a scoped group's alerts when that group IS hub_avsec
  // (or when viewing the unscoped org-wide "all" total). This is what fixes
  // the "01 ALERTS on the Hub AVSEC dashboard, empty activity feed" report:
  // previously `alerts` counted overdue bays/incidents completely unscoped
  // (identical regardless of scopeGroup), while the feed below never
  // surfaced bay/incident events for ANY group — so the two could never
  // agree for a scoped view. Both are now scoped consistently.
  const overdueBays =
    scopeGroup === "all" || scopeGroup === "hub_avsec"
      ? (bayRes ?? []).filter((b) => b.hoursOnGround >= 4).length
      : 0;
  const incidentRows = (incidentsRes.data ?? []) as {
    id: string;
    transactions: { status: TransactionStatus; direction: Direction; route: TransactionRoute } | null;
  }[];
  const openIncidents =
    scopeGroup === "all"
      ? incidentRows.length
      : incidentRows.filter(
          (r) => r.transactions && opsGroupForTransaction(r.transactions.direction, r.transactions.status, r.transactions.route) === scopeGroup
        ).length;
  const alerts = overdueBays + openIncidents;

  // Report submissions aren't tagged by ops_group (only station/team), so
  // this count is org-wide regardless of `scopeGroup` — a documented
  // limitation, not an oversight (see final report).
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
async function getActivityFeed(scopeGroup: OpsGroup | "all"): Promise<ActivityRow[]> {
  const supabase = await createClient();
  const todayMY = todayISODateMY();

  const [dutyRes, txRes, submissions, incidentsRes] = await Promise.all([
    supabase
      .from("duty_records")
      .select("check_in_at, check_out_at, profiles(name, station, ops_group)")
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
      .select("id, incident_type, created_at, transactions(status, direction, route, transaction_number)")
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const rows: ActivityRow[] = [];

  const dutyRows = (dutyRes.data ?? []) as {
    check_in_at: string | null;
    check_out_at: string | null;
    profiles: { name: string; station: string | null; ops_group: OpsGroup | null } | null;
  }[];
  for (const d of dutyRows) {
    if (scopeGroup !== "all" && d.profiles?.ops_group !== scopeGroup) continue;
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
    const group = opsGroupForTransaction(t.direction, t.status, t.route);
    if (scopeGroup !== "all" && group !== scopeGroup) continue;
    const time = t.completed_at ?? t.created_at;
    rows.push({
      key: `tx-${t.transaction_number}-${time}`,
      time,
      activity: `${t.transaction_number} · ${t.direction === "OUTBOUND" ? "Outbound" : "Inbound"} movement`,
      location: group ? OPS_GROUP_LABELS[group] : t.route,
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
    transactions: { status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string } | null;
  }[];
  for (const inc of incidentRows) {
    const group = inc.transactions
      ? opsGroupForTransaction(inc.transactions.direction, inc.transactions.status, inc.transactions.route)
      : null;
    if (scopeGroup !== "all" && group !== scopeGroup) continue;
    rows.push({
      key: `incident-${inc.id}`,
      time: inc.created_at,
      activity: `Incident — ${inc.incident_type}${inc.transactions ? ` (${inc.transactions.transaction_number})` : ""}`,
      location: group ? OPS_GROUP_LABELS[group] : "—",
      status: "OPEN",
    });
  }

  rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return rows.slice(0, 20);
}
