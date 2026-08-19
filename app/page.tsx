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

  return (
    <div className="min-h-screen flex flex-col items-center gap-8 p-8">
      <div className="text-center mt-8">
        <h1 className="text-3xl font-bold">VECTA</h1>
        <p className="text-sm opacity-70 mt-1">Signed in as {profile.name}</p>
      </div>

      {orgWide ? (
        <div className="w-full max-w-3xl">
          <div className="flex flex-wrap gap-2 justify-center mb-6">
            <TabLink label="All ops groups" active={activeTab === "all"} href="/" />
            {OPS_GROUPS.map((g) => (
              <TabLink key={g} label={OPS_GROUP_LABELS[g]} active={activeTab === g} href={`/?ops=${g}`} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full max-w-3xl">
        {showReports && (
          <Link
            href={reportsHref}
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">Reports</h2>
            <p className="text-sm opacity-70 mt-2">AVSEC duty &amp; reports</p>
          </Link>
        )}
        {showScan && (
          <Link
            href="/avsec/scan"
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">Scan</h2>
            <p className="text-sm opacity-70 mt-2">
              {orgWide ? "Scan any transaction" : "Scan a transaction in your ops group"}
            </p>
          </Link>
        )}
        {showAdmin && (
          <Link
            href="/avsec/admin/users"
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">Admin</h2>
            <p className="text-sm opacity-70 mt-2">Users, whitelists, audit</p>
          </Link>
        )}
      </div>

      {orgWide && opsSummary ? (
        <div className="w-full max-w-3xl rounded-xl border p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide opacity-70 mb-3">
            {activeTab === "all" ? "Open transactions — all ops groups" : `Open transactions — ${OPS_GROUP_LABELS[activeTab]}`}
          </h3>
          {opsSummary.length === 0 ? (
            <p className="text-sm opacity-60">No open transactions right now.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {opsSummary.map((row) => (
                <li key={row.group} className="flex justify-between">
                  <span>{OPS_GROUP_LABELS[row.group]}</span>
                  <span className="font-mono">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TabLink({ label, active, href }: { label: string; active: boolean; href: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-4 py-1.5 text-sm ${active ? "bg-foreground text-background" : "opacity-70 hover:opacity-100"}`}
    >
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
