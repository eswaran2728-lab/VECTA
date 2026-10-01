import { requireProfile } from "@/lib/avsec/auth";
import {
  getDiscussionCategories,
  getDiscussionThreads,
  getIsDiscussionModerator,
} from "@/lib/discussions/queries";
import { DiscussionList } from "@/components/discussions/DiscussionList";

export const metadata = {
  title: "Discussion Board | VECTA",
  description: "Anonymous internal discussion board for authenticated VECTA personnel.",
};

export default async function DiscussionBoardPage() {
  await requireProfile();

  const [categories, threads, isModerator] = await Promise.all([
    getDiscussionCategories(),
    getDiscussionThreads(),
    getIsDiscussionModerator(),
  ]);

  return (
    <main className="min-h-screen pb-28">
      <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
        <DiscussionList
          categories={categories}
          threads={threads}
          isModerator={isModerator}
        />
      </div>
    </main>
  );
}
