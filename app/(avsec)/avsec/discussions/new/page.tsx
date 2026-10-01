import { requireProfile } from "@/lib/avsec/auth";
import { getDiscussionCategories } from "@/lib/discussions/queries";
import { CreateThreadForm } from "@/components/discussions/CreateThreadForm";

export const metadata = {
  title: "New Discussion | VECTA",
  description: "Create an anonymous internal discussion thread.",
};

export default async function NewDiscussionPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireProfile();
  const { category } = await searchParams;
  const categories = await getDiscussionCategories();

  return (
    <main className="min-h-screen pb-28">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <CreateThreadForm categories={categories} defaultCategoryId={category} />
      </div>
    </main>
  );
}
