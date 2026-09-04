import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth/guards";
import { UnifiedScanner } from "@/components/scan/UnifiedScanner";
import type { OpsGroup } from "@/lib/icms/database.types";

export const metadata: Metadata = { title: "Scan — VECTA" };
export const dynamic = "force-dynamic";

const ORG_WIDE_UNIFIED_ROLES = ["admin", "management", "enforcement"];

const OPS_GROUP_LABELS: Record<OpsGroup, string> = {
  operation_avsec: "Operation AVSEC",
  ifc_avsec: "IFC AVSEC",
  hub_avsec: "Hub AVSEC",
};

/**
 * Unified scan entry point, linked from the dashboard's Scan section for
 * so/aso/dse of any origin (AVSEC public.profiles or ICMS public.users).
 * The actual ops_group scope enforcement happens server-side in
 * lib/icms/actions/scan.ts's scanTransaction() — this page only makes sure
 * a signed-in user with a real ops_group (or an org-wide role) can reach
 * the scanner at all.
 */
export default async function UnifiedScanPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  const supabase = await createClient();

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
    supabase.from("users").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
  ]);
  const profile = avsecProfile ?? icmsProfile;
  if (!profile) redirect("/login?error=no-profile");

  const orgWide = ORG_WIDE_UNIFIED_ROLES.includes(profile.unified_role ?? "");
  if (!orgWide && !profile.ops_group) redirect("/?error=no-ops-group");

  const opsGroup = profile.ops_group as OpsGroup | null;
  const scopeChip = orgWide ? "All Ops Groups" : opsGroup ? OPS_GROUP_LABELS[opsGroup] : null;

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="flex items-center justify-between px-8 pt-6">
        <span className="font-display text-base font-extrabold tracking-[0.06em]">SCAN</span>
        {scopeChip ? <span className="vecta-chip">{scopeChip}</span> : null}
      </div>

      <div className="flex flex-1 items-center justify-center p-9">
        <div className="w-full max-w-[460px]">
          <UnifiedScanner />
        </div>
      </div>

    </main>
  );
}
