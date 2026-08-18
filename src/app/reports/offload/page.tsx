import { requireRole, DAILY_REPORT_ROLES, landingPathForRole } from "@/lib/auth";
import { loadDraft } from "@/lib/reports/drafts";
import { AppHeader } from "@/components/layout/AppHeader";
import { OffloadForm } from "@/components/forms/OffloadForm";
import { REPORT_META } from "@/lib/reference-data";

export default async function OffloadPage() {
  const profile = await requireRole(DAILY_REPORT_ROLES);
  const serverDraft = await loadDraft("offload");

  return (
    <main className="min-h-screen pb-16">
      <AppHeader
        profile={profile}
        title={REPORT_META.offload.name}
        backHref={landingPathForRole(profile.role)}
      />
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.offload.code}</p>
        <OffloadForm profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
