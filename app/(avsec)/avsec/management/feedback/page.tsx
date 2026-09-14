import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { getManagementFeedbackInbox } from "@/lib/avsec/feedback/queries";
import { ManagementFeedbackInbox } from "@/components/avsec/feedback/ManagementFeedbackInbox";

export default async function ManagementFeedbackPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ category?: string; status?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  await requireRole(MANAGEMENT_ROLES);

  const threads = await getManagementFeedbackInbox({
    category: searchParams.category as never,
    status: searchParams.status as never,
  });

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="text-xl font-bold font-display">Staff Feedback Inbox</h1>
          <p className="text-xs text-muted-foreground">
            Confidential staff feedback channel. Submitter identities are permanently stripped by access control.
          </p>
        </div>

        <ManagementFeedbackInbox initialThreads={threads} />
      </div>
    </main>
  );
}
