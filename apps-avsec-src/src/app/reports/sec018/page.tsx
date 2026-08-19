import { requireRole } from "@/lib/auth";
import { loadDraft } from "@/lib/reports/drafts";
import { AppHeader } from "@/components/layout/AppHeader";
import { Sec018Form } from "@/components/forms/Sec018Form";
import { REPORT_META } from "@/lib/reference-data";

export default async function Sec018Page() {
  const profile = await requireRole(["ASO"]);
  const serverDraft = await loadDraft("sec018");

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title={REPORT_META.sec018.name} backHref="/home" />
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec018.code}</p>
        <Sec018Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
