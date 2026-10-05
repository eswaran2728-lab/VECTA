import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UnifiedScanner } from "@/components/scan/UnifiedScanner";
import { resolveOperatorScope } from "@/lib/auth/operator-scope";

export const metadata: Metadata = { title: "Scan — VECTA" };
export const dynamic = "force-dynamic";


/**
 * Unified scan entry point, linked from the dashboard's Scan section.
 * Authority is canonical (active assignments + the approved station
 * capability model), enforced server-side in lib/icms/actions/scan.ts's
 * scanTransaction(); this page only keeps clearly ineligible roles out.
 */
export default async function UnifiedScanPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const scope = await resolveOperatorScope(supabase);
  if (!scope.source) redirect("/login?error=no-profile");

  // Merged operations model: only canonical station operators (and management/
  // enforcement leadership, view-only) reach the scanner. The scan action
  // additionally enforces the approved station-capability model and duty.
  const stationOperator = scope.roleCodes.some((c) => ["aso", "so", "sso", "dse"].includes(c));
  if (!stationOperator && !scope.orgWide) redirect("/?error=no-scan-access");
  const scopeChip = scope.orgWide ? "All Stations" : scope.station;

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
