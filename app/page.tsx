import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { opsGroupForTransaction } from "@/lib/icms/ops-group";
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

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ ops?: string }>;
}) {
  const { ops } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase
      .from("profiles")
      .select("unified_role, name, role, ops_group")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("users")
      .select("unified_role, name, ops_group")
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
  const reportsHref = avsecProfile?.role === "ASO" ? "/avsec/home" : "/avsec/dashboard";

  // Scan = the new unified scan entry point. Reachable by anyone carrying
  // an ops_group (either origin table) or an org-wide role.
  const userOpsGroup = (profile.ops_group ?? null) as OpsGroup | null;
  const showScan = Boolean(userOpsGroup) || orgWide;

  const showAdmin = role === "admin";

  const activeTab: OpsGroup | "all" = orgWide && ops && OPS_GROUPS.includes(ops as OpsGroup) ? (ops as OpsGroup) : "all";

  const opsSummary = orgWide ? await getOpsGroupSummary(activeTab) : null;

  const roleChip = role ? role.charAt(0).toUpperCase() + role.slice(1) : null;
  const maxCount = opsSummary && opsSummary.length > 0 ? Math.max(1, ...opsSummary.map((r) => r.count)) : 1;

  return (
    <main className="dark relative min-h-screen bg-background">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 600px 340px at 90% -10%, oklch(0.62 0.2 300 / 0.22), transparent 60%), radial-gradient(ellipse 600px 340px at 0% 100%, oklch(0.78 0.14 220 / 0.18), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        <div className="flex items-center justify-between border-b border-border px-8 py-[18px]">
          <div className="flex items-center gap-2.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 2 L21 6 V12 C21 17 17 21 12 22 C7 21 3 17 3 12 V6 Z"
                stroke="var(--cyan)"
                strokeWidth="1.6"
              />
            </svg>
            <span className="font-display text-[17px] font-extrabold tracking-[0.06em]">VECTA</span>
            <span className="vecta-eyebrow ml-1">{"// OPS.DASHBOARD"}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="font-mono text-sm">
              Signed in as {profile.name}
            </span>
            {roleChip ? <span className="vecta-chip">{roleChip}</span> : null}
          </div>
        </div>

        <div className="flex flex-col gap-6 px-8 py-8">
          {orgWide ? (
            <div className="vecta-pill-tabs w-fit">
              <TabPill label="All Ops Groups" active={activeTab === "all"} href="/" />
              {OPS_GROUPS.map((g) => (
                <TabPill key={g} label={OPS_GROUP_LABELS[g]} active={activeTab === g} href={`/?ops=${g}`} />
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-4 sm:flex-row">
            {showReports && (
              <Link href={reportsHref} className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <path d="M6 3h9l3 3v15H6z" stroke="var(--cyan)" strokeWidth="1.6" />
                  <path d="M9 10h6M9 14h6M9 18h4" stroke="var(--cyan)" strokeWidth="1.6" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">Reports</h2>
                <p className="vecta-eyebrow mt-1">AVSEC duty &amp; security reports</p>
              </Link>
            )}
            {showScan && (
              <Link href="/avsec/scan" className="vecta-tile group">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="mb-3.5" aria-hidden="true">
                  <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" stroke="var(--violet)" strokeWidth="1.6" />
                  <rect x="9" y="9" width="6" height="6" stroke="var(--violet)" strokeWidth="1.6" />
                </svg>
                <h2 className="font-display text-xl font-bold tracking-[0.03em]">Scan</h2>
                <p className="vecta-eyebrow mt-1">
                  {orgWide ? "Scan any transaction · org-wide" : "Scan a transaction in your ops group"}
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
                          style={{
                            background: clear ? "var(--green)" : "var(--cyan)",
                            boxShadow: clear
                              ? "0 0 8px 1px oklch(0.78 0.17 150 / 0.7)"
                              : "0 0 8px 1px var(--cyan)",
                          }}
                        />
                        <span className="w-[150px] shrink-0 text-sm">{OPS_GROUP_LABELS[row.group]}</span>
                        <div className="h-[6px] flex-1 rounded-full bg-input">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(clear ? 4 : 0, (row.count / maxCount) * 100)}%`,
                              background: clear
                                ? "var(--green)"
                                : "linear-gradient(90deg, var(--cyan), var(--violet))",
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
        </div>
      </div>
    </main>
  );
}

function TabPill({ label, active, href }: { label: string; active: boolean; href: string }) {
  return (
    <Link href={href} className={`vecta-pill${active ? " is-active" : ""}`}>
      {label}
    </Link>
  );
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
