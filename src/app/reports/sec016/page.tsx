import { requireProfile } from "@/lib/auth";
import { loadDraft } from "@/lib/reports/drafts";
import { AppHeader } from "@/components/layout/AppHeader";
import { Sec016Form } from "@/components/forms/Sec016Form";
import { REPORT_META } from "@/lib/reference-data";

export default async function Sec016Page() {
  const profile = await requireProfile();
  const serverDraft = await loadDraft("sec016");

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title={REPORT_META.sec016.name} backHref="/home" />
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec016.code}</p>
        <Sec016Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
