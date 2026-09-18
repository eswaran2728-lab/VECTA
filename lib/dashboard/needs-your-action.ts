import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { getShiftCompliance } from "@/lib/avsec/dashboard/queries";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { todayISODateMY, formatDateTimeMY } from "@/lib/avsec/datetime";
import type { Profile } from "@/lib/avsec/types";
import type { UserProfile } from "@/lib/icms/database.types";

export interface ActionItem {
  id: string;
  source: "avsec" | "icms";
  category: string;
  title: string;
  detail: string;
  href: string;
  overdue: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

// Thresholds confirmed with Eswar 2026-09-14 — do not change without re-confirming.
const SEC_REPORT_OVERDUE_HOURS = 2; // after shift/flight end
const INCIDENT_OVERDUE_HOURS = 24; // unactioned
const CATERING_OVERDUE_HOURS = 2; // past expected clearance
const OT_LEAVE_OVERDUE_HOURS = 24; // pending

function hoursAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / HOUR_MS;
}

/**
 * Aggregates "needs your action" items for the signed-in person across both
 * apps that share this Supabase project — AVSEC (profiles table) and ICMS/
 * CaterLink (users table). A person may have a row in either, both, or
 * neither; this reads whichever rows exist rather than assuming one.
 */
export async function getNeedsYourActionItems(): Promise<ActionItem[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    supabase.from("users").select("*").eq("id", user.id).maybeSingle(),
  ]);

  const items: ActionItem[] = [];
  if (avsecProfile) items.push(...(await getAvsecActionItems(avsecProfile as unknown as Profile)));
  if (icmsProfile) items.push(...(await getIcmsActionItems(icmsProfile as unknown as UserProfile)));
  return items;
}

async function getAvsecActionItems(profile: Profile): Promise<ActionItem[]> {
  const supabase = await createClient();
  const items: ActionItem[] = [];
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role) || profile.role === "ADMIN";
  const isDse = profile.role === "DSE";
  const isMonitor = isOrgWide || profile.role === "SO" || isDse;
  if (!isMonitor) return items;

  const today = todayISODateMY();
  const station = isOrgWide ? undefined : profile.station ?? undefined;

  // Bay Board — aircraft overdue for a SEC 029 search (existing 4h-on-ground
  // heuristic already used elsewhere on the dashboard; surfaced here too so
  // it shows in one place with everything else needing action).
  const bayBoard = await getOpenBayBoard(station);
  for (const a of bayBoard.filter((b) => b.hoursOnGround >= 4)) {
    items.push({
      id: `bay-${a.id}`,
      source: "avsec",
      category: "Aircraft Search Overdue",
      title: `${a.reg_no} · Bay ${a.bay}`,
      detail: `${a.station} · ${a.hoursOnGround.toFixed(1)}h on ground — SEC 029 search required`,
      href: `/avsec/bay-board`,
      overdue: true,
    });
  }

  // SEC 014 shift compliance — officer hasn't filed today's patrol report and
  // their rostered shift ended >= 2h ago.
  if (station) {
    const [compliance, rosterRows] = await Promise.all([
      getShiftCompliance(station, today, isOrgWide ? undefined : profile.team ?? undefined),
      supabase.from("team_rosters").select("team, end_time").eq("station", station).eq("roster_date", today),
    ]);
    const endTimeByTeam = new Map((rosterRows.data ?? []).map((r) => [r.team, r.end_time]));
    for (const c of compliance) {
      if (c.submitted) continue;
      const endTime = endTimeByTeam.get(c.profile.team ?? "");
      if (!endTime) continue;
      const shiftEnd = new Date(`${today}T${endTime}+08:00`);
      const hoursSinceEnd = (Date.now() - shiftEnd.getTime()) / HOUR_MS;
      if (hoursSinceEnd >= SEC_REPORT_OVERDUE_HOURS) {
        items.push({
          id: `sec014-${c.profile.id}`,
          source: "avsec",
          category: "SEC 014 Report Missing",
          title: c.profile.name,
          detail: `${c.profile.team ?? ""} · shift ended ${hoursSinceEnd.toFixed(1)}h ago, no patrol report filed`,
          href: `/avsec/dashboard`,
          overdue: true,
        });
      }
    }
  }

  // ASO Daily Reports (SEC014) awaiting SO/DSE acknowledgement — the
  // supervisor's own station/team scope, since that's exactly who
  // can_acknowledge_report() (see supabase/migrations/20260917000001_*)
  // actually lets acknowledge them. Org-wide roles aren't included: they
  // already have full report search, and the rank-based acknowledgement
  // rule doesn't grant them this action anyway.
  if ((profile.role === "SO" || isDse) && station) {
    let pendingReportsQuery = supabase
      .from("report_sec014")
      .select("id, staff_name, staff_id, team, submitted_at")
      .eq("status", "submitted")
      .eq("station", station)
      .eq("team", profile.team ?? "");
    if (profile.ops_group) {
      pendingReportsQuery = pendingReportsQuery.eq("ops_group", profile.ops_group);
    }
    const { data: pendingReports } = await pendingReportsQuery;
    if (pendingReports && pendingReports.length > 0) {
      const { data: acked } = await supabase
        .from("report_acknowledgements")
        .select("report_id")
        .eq("report_type", "sec014")
        .in(
          "report_id",
          pendingReports.map((r) => r.id),
        );
      const ackedIds = new Set((acked ?? []).map((a) => a.report_id));
      for (const r of pendingReports) {
        if (ackedIds.has(r.id)) continue;
        items.push({
          id: `sec014-ack-${r.id}`,
          source: "avsec",
          category: "Daily Report Awaiting Acknowledgement",
          title: r.staff_name,
          detail: `${r.staff_id} · ${r.team ?? ""} · submitted ${formatDateTimeMY(r.submitted_at, "HH:mm")}`,
          href: `/avsec/reports/view/sec014/${r.id}`,
          overdue: false,
        });
      }
    }
  }

  // Overtime pending approval, scoped to the reviewer's own team (DSE) or
  // everyone (Management/Admin/Enforcement).
  if (isDse || isOrgWide) {
    let otQuery = supabase
      .from("overtime_requests")
      .select("id, profile_id, station, team, work_date, payable_hours, created_at")
      .eq("status", "pending");
    if (!isOrgWide) otQuery = otQuery.eq("station", profile.station ?? "").eq("team", profile.team ?? "");
    const { data: otRows } = await otQuery;
    const pendingOtherIds = (otRows ?? []).map((r) => r.profile_id).filter((id) => id !== profile.id);
    let otNameById = new Map<string, string>();
    if (pendingOtherIds.length > 0) {
      const { data: names } = await supabase.from("profiles").select("id, name").in("id", pendingOtherIds);
      otNameById = new Map((names ?? []).map((p) => [p.id, p.name]));
    }
    for (const r of otRows ?? []) {
      if (r.profile_id === profile.id) continue; // can't approve your own OT
      const hoursPending = hoursAgo(r.created_at);
      if (hoursPending < OT_LEAVE_OVERDUE_HOURS) continue;
      items.push({
        id: `ot-${r.id}`,
        source: "avsec",
        category: "OT Approval Pending",
        title: otNameById.get(r.profile_id) ?? "Team member",
        detail: `${r.payable_hours}h · ${r.work_date} · pending ${hoursPending.toFixed(0)}h`,
        href: `/avsec/duty/overtime/${r.id}`,
        overdue: true,
      });
    }
  }

  // Leave/absence notices pending approval, same scoping as OT.
  if (isDse || isOrgWide) {
    let leaveQuery = supabase
      .from("absence_notices")
      .select("id, staff_name, submitted_at, leave_type")
      .in("approval_status", ["pending", "pending_cancellation"]);
    if (!isOrgWide) leaveQuery = leaveQuery.eq("station", profile.station ?? "").eq("team", profile.team ?? "");
    const { data: leaveRows } = await leaveQuery;
    for (const r of leaveRows ?? []) {
      const hoursPending = hoursAgo(r.submitted_at);
      if (hoursPending < OT_LEAVE_OVERDUE_HOURS) continue;
      items.push({
        id: `leave-${r.id}`,
        source: "avsec",
        category: "Leave Approval Pending",
        title: r.staff_name,
        detail: `${r.leave_type} · pending ${hoursPending.toFixed(0)}h`,
        href: `/avsec/duty/absences?highlight=${r.id}`,
        overdue: true,
      });
    }
  }

  return items;
}

async function getIcmsActionItems(profile: UserProfile): Promise<ActionItem[]> {
  const canReview = profile.role === "supervisor" || profile.role === "enforcement" || profile.role === "management";
  if (!canReview) return [];

  const supabase = await createClient();
  const items: ActionItem[] = [];

  const { data: incidents } = await supabase
    .from("incidents")
    .select("id, incident_type, created_at, transaction_id, transactions!inner(transaction_number, archived)")
    .eq("status", "OPEN")
    .eq("transactions.archived", false);
  for (const inc of (incidents ?? []) as unknown as {
    id: string;
    incident_type: string;
    created_at: string;
    transactions: { transaction_number: string } | null;
  }[]) {
    const hoursOpen = hoursAgo(inc.created_at);
    if (hoursOpen < INCIDENT_OVERDUE_HOURS) continue;
    items.push({
      id: `incident-${inc.id}`,
      source: "icms",
      category: "Incident Review Overdue",
      title: inc.transactions?.transaction_number ?? "Incident",
      detail: `${inc.incident_type} · open ${hoursOpen.toFixed(0)}h`,
      href: `/icms/incidents?highlight=${inc.id}`,
      overdue: true,
    });
  }

  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, transaction_number, status, status_entered_at")
    .eq("archived", false)
    .in("status", ["CREATED", "INFLIGHT_POST_APPROVED", "AIRPORT_POST_APPROVED"]);
  for (const tx of transactions ?? []) {
    const hoursInStatus = hoursAgo(tx.status_entered_at);
    if (hoursInStatus < CATERING_OVERDUE_HOURS) continue;
    items.push({
      id: `tx-${tx.id}`,
      source: "icms",
      category: "Catering Movement Overdue",
      title: tx.transaction_number,
      detail: `${tx.status.replaceAll("_", " ")} · ${hoursInStatus.toFixed(1)}h past expected clearance`,
      href: `/icms/transactions/${tx.id}`,
      overdue: true,
    });
  }

  return items;
}
