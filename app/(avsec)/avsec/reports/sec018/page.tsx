import { requireRole } from "@/lib/avsec/auth";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { Sec018Form } from "@/components/avsec/forms/Sec018Form";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function Sec018Page() {
  const profile = await requireRole(["ASO"]);
  const serverDraft = await loadDraft("sec018");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec018.code}</p>
        <Sec018Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
