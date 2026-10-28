import { requireReportFormAccess } from "@/lib/avsec/reports/form-capability";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { BreakupForm } from "@/components/avsec/forms/BreakupForm";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function BreakupPage() {
  const profile = await requireReportFormAccess("breakup");
  const serverDraft = await loadDraft("breakup");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.breakup.code}</p>
        <BreakupForm profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
