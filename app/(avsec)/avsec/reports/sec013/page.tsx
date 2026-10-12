import { requireRouteAccess } from "@/lib/avsec/auth";
import { requireReportFormAccess } from "@/lib/avsec/reports/form-capability";
import { loadDraft } from "@/lib/avsec/reports/drafts";
import { Sec013Form } from "@/components/avsec/forms/Sec013Form";
import { REPORT_META } from "@/lib/avsec/reference-data";

export default async function Sec013Page() {
  // Two independent gates: the dashboard-link route policy, then the person's ASSIGNED form (report_form_assignments).
  await requireRouteAccess("/avsec/reports/sec013", []);
  const profile = await requireReportFormAccess("sec013");

  const serverDraft = await loadDraft("sec013");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6">
        <p className="form-code-badge mb-4">{REPORT_META.sec013.code}</p>
        <Sec013Form profile={profile} serverDraft={serverDraft as never} />
      </div>
    </main>
  );
}
