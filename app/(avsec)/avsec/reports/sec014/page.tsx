import { requireRole, DAILY_REPORT_ROLES, landingPathForRole } from "@/lib/avsec/auth";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { Sec014Form } from "@/components/avsec/forms/Sec014Form";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function Sec014Page() {
  const profile = await requireRole(DAILY_REPORT_ROLES);
  const serverDraft = await loadDraft("sec014");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec014.code}</p>
        <Sec014Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
