import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/lib/avsec/profile-actions";
import { getOrganizations, isSuperAdmin } from "@/lib/super-admin/actions";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { OrgManager } from "./org-manager";

export default async function SuperAdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const isSuper = await isSuperAdmin();
  if (!isSuper) {
    redirect("/?error=unauthorized-super-admin");
  }

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase.from("profiles").select("name").eq("id", user.id).maybeSingle(),
    supabase.from("users").select("name").eq("id", user.id).maybeSingle(),
  ]);

  const name = avsecProfile?.name || icmsProfile?.name || user.email || "Super Admin";
  const orgs = await getOrganizations();

  return (
    <main className="min-h-screen bg-background pb-20">
      <UnifiedHeader
        name={name}
        roleLabel="Super Admin"
        signOutAction={signOut}
        homeHref="/super-admin"
      />

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <OrgManager initialOrgs={orgs} userName={name} />
      </div>
    </main>
  );
}
