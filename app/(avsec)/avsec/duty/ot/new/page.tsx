import { redirect } from "next/navigation";
import { requireProfile, landingPathForRole } from "@/lib/avsec/auth";
import { OtNewForm } from "./ot-new-form";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { signOut } from "@/lib/avsec/profile-actions";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";

export default async function NewOtRequestPage() {
  const profile = await requireProfile();

  if (profile.role !== "ASO") {
    redirect(landingPathForRole(profile.role));
  }

  const orgWide = false;

  return (
    <main className="min-h-screen bg-background pb-28">
      <UnifiedHeader
        name={profile.name}
        roleLabel="ASO"
        signOutAction={signOut}
        homeHref="/avsec/home"
      />

      <div className="mx-auto max-w-2xl px-4 py-8">
        <OtNewForm profile={profile} />
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} role={profile.role} />
    </main>
  );
}
