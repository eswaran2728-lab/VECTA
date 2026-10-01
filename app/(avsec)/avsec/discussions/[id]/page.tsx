import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import {
  getDiscussionThread,
  getDiscussionCategories,
  getMyDiscussionAuthoredIds,
  getIsDiscussionModerator,
} from "@/lib/discussions/queries";
import { ThreadDetailView } from "@/components/discussions/ThreadDetailView";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const thread = await getDiscussionThread(id);
  if (!thread) {
    return { title: "Discussion Not Found | VECTA" };
  }
  return {
    title: `${thread.title} | VECTA Discussions`,
    description: `Anonymous internal discussion: ${thread.title}`,
  };
}

export default async function DiscussionThreadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireProfile();
  const { id } = await params;

  const [thread, categories, authored, isModerator] = await Promise.all([
    getDiscussionThread(id),
    getDiscussionCategories(),
    getMyDiscussionAuthoredIds(id),
    getIsDiscussionModerator(),
  ]);

  if (!thread) {
    notFound();
  }

  const category = categories.find((c) => c.id === thread.category_id);
  const categoryName = category?.display_name || "General";

  return (
    <main className="min-h-screen pb-28">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <ThreadDetailView
          thread={thread}
          categoryName={categoryName}
          isThreadOwner={authored.isThreadOwner}
          ownedReplyIds={authored.ownedReplyIds}
          isModerator={isModerator}
        />
      </div>
    </main>
  );
}
