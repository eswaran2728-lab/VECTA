import { requireRole } from "@/lib/avsec/auth";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { Sec029Form } from "@/components/avsec/forms/Sec029Form";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function Sec029Page() {
  const profile = await requireRole(["ASO"]);
  const serverDraft = await loadDraft("sec029");

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title={REPORT_META.sec029.name} backHref="/avsec/home" />
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec029.code}</p>
        <Sec029Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
