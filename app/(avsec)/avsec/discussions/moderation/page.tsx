import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getIsDiscussionModerator, getDiscussionReports } from "@/lib/discussions/queries";
import { ModerationDashboard } from "@/components/discussions/ModerationDashboard";

export const metadata = {
  title: "Discussion Moderation | VECTA",
  description: "Moderation dashboard and audit console for VECTA discussion board.",
};

export default async function DiscussionModerationPage() {
  await requireProfile();
  const isModerator = await getIsDiscussionModerator();

  if (!isModerator) {
    redirect("/avsec/discussions");
  }

  const reports = await getDiscussionReports();

  return (
    <main className="min-h-screen pb-28">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <ModerationDashboard initialReports={reports} />
      </div>
    </main>
  );
}
