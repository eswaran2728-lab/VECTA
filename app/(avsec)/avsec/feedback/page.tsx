import { requireProfile } from "@/lib/avsec/auth";
import { getMyFeedbackThreads } from "@/lib/avsec/feedback/queries";
import { StaffFeedbackList } from "@/components/avsec/feedback/StaffFeedbackList";

export default async function StaffFeedbackPage() {
  const profile = await requireProfile();
  const threads = await getMyFeedbackThreads(profile.id);

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6">
        <StaffFeedbackList initialThreads={threads} />
      </div>
    </main>
  );
}
