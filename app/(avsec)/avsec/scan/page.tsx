import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UnifiedScanner } from "@/components/scan/UnifiedScanner";

export const metadata: Metadata = { title: "Scan — VECTA" };
export const dynamic = "force-dynamic";

const ORG_WIDE_UNIFIED_ROLES = ["admin", "management", "enforcement"];

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

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
    supabase.from("users").select("unified_role, ops_group").eq("id", user.id).maybeSingle(),
  ]);
  const profile = avsecProfile ?? icmsProfile;
  if (!profile) redirect("/login?error=no-profile");

  const orgWide = ORG_WIDE_UNIFIED_ROLES.includes(profile.unified_role ?? "");
  if (!orgWide && !profile.ops_group) redirect("/?error=no-ops-group");

  return (
    <main className="mx-auto max-w-lg space-y-4 p-4">
      <h1 className="text-lg font-semibold">Scan</h1>
      <p className="text-sm text-muted-foreground">
        Scan a CaterLink QR code, or enter a transaction reference manually.
      </p>
      <UnifiedScanner />
    </main>
  );
}
