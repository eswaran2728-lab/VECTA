import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasActiveSuperAdminRole } from "@/lib/super-admin/actions";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { signOut } from "@/lib/avsec/profile-actions";

interface LegacyRoleMappingRow {
  profile_id: string;
  legacy_role: string;
  profile_status: string;
  has_replacement_assignment: boolean;
  active_replacement_role_codes: string[];
}

/**
 * Phase 13: read-only release-readiness and legacy-role-mapping view for
 * Super Admin / the designated technical authority only. Exposes only
 * operational status booleans and small counts -- never a secret, key,
 * connection string, JWT, signed URL, or confidential report content. Every
 * view is itself audited server-side (see
 * view_release_readiness_report_secure / view_legacy_role_mapping_report_secure
 * in the Phase 13 migration).
 */
export default async function ReadinessPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const isSuper = await hasActiveSuperAdminRole();
  if (!isSuper) {
    redirect("/?error=unauthorized-super-admin");
  }

  const { data: avsecProfile } = await supabase.from("profiles").select("name").eq("id", user.id).maybeSingle();
  const name = avsecProfile?.name || user.email || "Super Admin";

  const [{ data: readinessRaw, error: readinessError }, { data: legacyRows, error: legacyError }] = await Promise.all([
    supabase.rpc("view_release_readiness_report_secure"),
    supabase.rpc("view_legacy_role_mapping_report_secure"),
  ]);

  // The database has no visibility into this Node process's environment,
  // so it always reports wois_provider_configured: false -- merge in the
  // real boolean here, server-side, from the same config the chat route
  // itself uses (lib/wois/config.ts). This is a status boolean only, never
  // the key itself.
  const { getWoisAiConfig } = await import("@/lib/wois/config");
  const readiness = readinessRaw
    ? { ...(readinessRaw as Record<string, unknown>), wois_provider_configured: getWoisAiConfig().provider === "gemini" }
    : readinessRaw;

  const legacyWithoutReplacement = ((legacyRows ?? []) as LegacyRoleMappingRow[]).filter((r) => !r.has_replacement_assignment);

  return (
    <main className="min-h-screen bg-background pb-20">
      <UnifiedHeader name={name} roleLabel="Super Admin" signOutAction={signOut} homeHref="/super-admin" />

      <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-xl font-bold font-display">Release Readiness</h1>
          <p className="text-xs text-muted-foreground">
            Operational status only -- no secrets, keys, or confidential record content are ever shown here.
          </p>
        </div>

        {readinessError ? (
          <p className="text-sm text-red-500">Could not load the readiness report: {readinessError.message}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.entries((readiness as Record<string, unknown>) ?? {}).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-border bg-card p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{key}</p>
                <p className="text-sm font-semibold text-foreground">{String(value)}</p>
              </div>
            ))}
          </div>
        )}

        <div>
          <h2 className="text-base font-bold font-display">Legacy Role Mapping -- Retirement Gate</h2>
          <p className="text-xs text-muted-foreground">
            Dry-run only. Legacy MANAGEMENT/ADMIN/ENFORCEMENT access may not be retired while any row below shows
            no replacement assignment.
          </p>
        </div>

        {legacyError ? (
          <p className="text-sm text-red-500">Could not load the legacy-role mapping report: {legacyError.message}</p>
        ) : (
          <div className="rounded-lg border border-border bg-card p-3 text-xs">
            <p className="font-semibold text-foreground">
              {legacyWithoutReplacement.length} of {(legacyRows ?? []).length} legacy-role profile(s) have no active
              replacement assignment yet.
            </p>
            {legacyWithoutReplacement.length > 0 && (
              <p className="mt-2 text-amber-500">
                Retirement gate: BLOCKED until every legacy-role profile has an approved replacement assignment.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
