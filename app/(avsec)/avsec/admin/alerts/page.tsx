import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { createClient } from "@/lib/supabase/server";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { hoursSince } from "@/lib/avsec/datetime";
import { opsGroupForTransaction } from "@/lib/icms/ops-group";
import { INCIDENT_TYPE_LABELS } from "@/lib/icms/constants";
import type { Direction, OpsGroup, TransactionRoute, TransactionStatus } from "@/lib/icms/database.types";

export const metadata = { title: "Open Alerts" };
export const dynamic = "force-dynamic";

interface AlertRow {
  key: string;
  reason: string;
  ageHours: number;
  owner: string;
  action: { label: string; href: string };
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ ops?: string }>;
}) {
  const { ops } = await searchParams;
  const profile = await requireProfile();

  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const requestedTab = ops === "operation_avsec" || ops === "ifc_avsec" || ops === "hub_avsec" ? ops : "all";
  // Same rule as the dashboard's own scopeGroup (app/page.tsx): an org-wide
  // viewer gets whichever tab they picked (or "all"); anyone else is always
  // pinned to their own ops_group, regardless of what's in the URL.
  const scopeGroup: OpsGroup | "all" = orgWide ? requestedTab : (profile.ops_group ?? "all");

  const supabase = await createClient();

  // Same two sources and scoping rule as the "Alerts" tile on the Home
  // dashboard (getDashboardSnapshot in app/page.tsx) — this page exists so
  // that count is no longer a dead end.
  const [bays, incidentsRes] = await Promise.all([
    getOpenBayBoard(),
    supabase
      .from("incidents")
      .select(
        "id, transaction_id, incident_type, description, reported_by, created_at, transactions(status, direction, route, transaction_number)"
      )
      .is("resolved_at", null)
      .limit(500),
  ]);

  const rows: AlertRow[] = [];

  const overdueBays = bays.filter((b) => b.hoursOnGround >= 4);
  if (scopeGroup === "all" || scopeGroup === "hub_avsec") {
    for (const b of overdueBays) {
      rows.push({
        key: `bay-${b.id}`,
        reason: `${b.reg_no}${b.flight ? ` (${b.flight})` : ""} on ground ${formatAge(b.hoursOnGround)} — mandatory SEC029 search required`,
        ageHours: b.hoursOnGround,
        owner: `${b.station} · Bay ${b.bay}`,
        action: { label: "File SEC029 search", href: "/avsec/reports/sec029" },
      });
    }
  }

  const incidentRows = (incidentsRes.data ?? []) as {
    id: string;
    transaction_id: string;
    incident_type: keyof typeof INCIDENT_TYPE_LABELS;
    description: string;
    reported_by: string;
    created_at: string;
    transactions: { status: TransactionStatus; direction: Direction; route: TransactionRoute; transaction_number: string } | null;
  }[];
  for (const i of incidentRows) {
    if (
      scopeGroup !== "all" &&
      (!i.transactions || opsGroupForTransaction(i.transactions.direction, i.transactions.status, i.transactions.route) !== scopeGroup)
    ) {
      continue;
    }
    const ageHours = hoursSince(i.created_at);
    rows.push({
      key: `incident-${i.id}`,
      reason: `${INCIDENT_TYPE_LABELS[i.incident_type] ?? i.incident_type}${i.transactions ? ` on ${i.transactions.transaction_number}` : ""} — "${i.description}"`,
      ageHours,
      owner: i.reported_by,
      action: { label: "Resolve or close", href: "/icms/incidents" },
    });
  }

  rows.sort((a, b) => b.ageHours - a.ageHours);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Open Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Overdue aircraft-on-ground (≥4h, SEC029 due) and open incidents — the same count shown on the
          dashboard&apos;s Alerts tile.
        </p>
      </div>

      <div className="vecta-panel overflow-hidden !p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No open alerts right now.</p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                <th className="px-4 py-2.5 font-mono font-medium">Reason</th>
                <th className="px-4 py-2.5 font-mono font-medium">Age</th>
                <th className="px-4 py-2.5 font-mono font-medium">Owner</th>
                <th className="px-4 py-2.5 font-mono font-medium">Required Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border/60 last:border-none hover:bg-muted/20">
                  <td className="px-4 py-3 text-[13px]">{row.reason}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-brand font-semibold">
                    {formatAge(row.ageHours)}
                  </td>
                  <td className="px-4 py-3 text-[13px] text-muted-foreground">{row.owner}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <Link href={row.action.href} className="text-[13px] font-medium text-primary hover:underline">
                      {row.action.label} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
