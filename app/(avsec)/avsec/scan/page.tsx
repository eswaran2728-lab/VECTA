import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UnifiedScanner } from "@/components/scan/UnifiedScanner";
import type { OpsGroup } from "@/lib/icms/database.types";
import { resolveOperatorScope } from "@/lib/auth/operator-scope";

export const metadata: Metadata = { title: "Scan — VECTA" };
export const dynamic = "force-dynamic";


// Unified AVSEC scanning model: Operation and IFC branches scan under one
// label here (they're interchangeable for CaterLink checkpoints — see
// lib/icms/ops-group.ts). Hub AVSEC keeps its own distinct label; it
// remains a separate, unmerged scanning scope.
const OPS_GROUP_LABELS: Record<OpsGroup, string> = {
  operation_avsec: "AVSEC",
  ifc_avsec: "AVSEC",
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const scope = await resolveOperatorScope(supabase, user.id);
  if (!scope.source) redirect("/login?error=no-profile");

  const orgWide = scope.orgWide;
  if (!orgWide && !scope.opsGroup) redirect("/?error=no-ops-group");

  const opsGroup = scope.opsGroup as OpsGroup | null;
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
