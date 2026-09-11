import { requireProfile } from "@/lib/avsec/auth";
import { getOtRequests } from "@/lib/avsec/duty/ot-actions";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { signOut } from "@/lib/avsec/profile-actions";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { OtView } from "./ot-view";
import { ORG_WIDE_ROLES, ROLE_LABELS } from "@/lib/avsec/reference-data";

export default async function OtPage() {
  const profile = await requireProfile();
  const requests = await getOtRequests();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role) || (profile.role as string) === "ADMIN";

  return (
    <main className="min-h-screen bg-background pb-28">
      <UnifiedHeader
        name={profile.name}
        roleLabel={ROLE_LABELS[profile.role]}
        signOutAction={signOut}
        homeHref={profile.role === "ASO" ? "/avsec/home" : "/avsec/dashboard"}
      />

      <div className="mx-auto max-w-4xl px-4 py-8">
        <OtView
          initialRequests={requests}
          userRole={profile.role}
          userBranch={profile.ops_group}
        />
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} role={profile.role} />
    </main>
  );
}
