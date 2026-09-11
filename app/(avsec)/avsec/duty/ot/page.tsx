import { requireProfile } from "@/lib/avsec/auth";
import { getOtRequests } from "@/lib/avsec/duty/ot-actions";
import { OtView } from "./ot-view";

export default async function OtPage() {
  const profile = await requireProfile();
  const requests = await getOtRequests();

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <OtView
          initialRequests={requests}
          userRole={profile.role}
          userBranch={profile.ops_group}
        />
      </div>
    </main>
  );
}
