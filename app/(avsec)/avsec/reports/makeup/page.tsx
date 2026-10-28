import { requireReportFormAccess } from "@/lib/avsec/reports/form-capability";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { MakeupForm } from "@/components/avsec/forms/MakeupForm";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function MakeupPage() {
  const profile = await requireReportFormAccess("makeup");
  const serverDraft = await loadDraft("makeup");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.makeup.code}</p>
        <MakeupForm profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
