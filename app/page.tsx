import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/icms/database.types";

// Until the two Supabase projects are merged (a separate, later task — see
// Phase 5/12 of the merge), role checks run against ICMS's `users.role`
// column, the only role table the single shared client can see. AVSEC's own
// role list (ASO/SO/DSE/ENFORCEMENT/MANAGEMENT/ADMIN) doesn't exist there yet,
// so the mapping below is a best-effort bridge, not a real role merge.
const AVSEC_ACCESS_ROLES: Role[] = ["enforcement", "supervisor"];
const ADMIN_ROLES: Role[] = ["supervisor"];

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role, name")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login?error=no-profile");

  const role = profile.role as Role;
  const showIfc = true; // every active ICMS user row has an ICMS-side role
  const showAvsec = AVSEC_ACCESS_ROLES.includes(role);
  const showAdmin = ADMIN_ROLES.includes(role);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold">VECTA</h1>
        <p className="text-sm opacity-70 mt-1">Signed in as {profile.name}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full max-w-3xl">
        {showIfc && (
          <Link
            href="/icms"
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">IFC</h2>
            <p className="text-sm opacity-70 mt-2">
              In-Flight Catering security workflow
            </p>
          </Link>
        )}
        {showAvsec && (
          <Link
            href="/avsec"
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">Reports</h2>
            <p className="text-sm opacity-70 mt-2">AVSEC duty &amp; reports</p>
          </Link>
        )}
        {showAdmin && (
          <Link
            href="/icms/admin"
            className="rounded-xl border p-8 text-center hover:shadow-lg transition-shadow"
          >
            <h2 className="text-xl font-semibold">Admin</h2>
            <p className="text-sm opacity-70 mt-2">Users, whitelists, audit</p>
          </Link>
        )}
      </div>
    </div>
  );
}
