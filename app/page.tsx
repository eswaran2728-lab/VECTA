import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Unified role vocabulary (supabase/migrations/unified_role_model):
// admin, management, enforcement, so, aso, dse, vendor. Org-wide roles
// (admin/management/enforcement) get both apps; so/aso/dse/vendor get
// whichever app their account actually lives in (public.profiles for
// AVSEC-origin, public.users for ICMS-origin) — a bare "aso" mapping
// doesn't by itself grant ICMS RLS access, since that's keyed off having
// an actual public.users row, not just the unified_role string.
const ORG_WIDE_ROLES = ["admin", "management", "enforcement"];

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
    supabase
      .from("profiles")
      .select("unified_role, name")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("users")
      .select("unified_role, name")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  const profile = avsecProfile ?? icmsProfile;
  if (!profile) redirect("/login?error=no-profile");

  const role = profile.unified_role as string | null;
  const orgWide = role ? ORG_WIDE_ROLES.includes(role) : false;

  const showIfc = Boolean(icmsProfile) || orgWide;
  const showAvsec = Boolean(avsecProfile) || orgWide;
  const showAdmin = role === "admin";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold">VECTA</h1>
        <p className="text-sm opacity-70 mt-1">Signed in as {profile.name}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 w-full max-w-3xl">
        {showIfc && (
          <Link
            href="/icms/dashboard"
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
            href="/avsec/home"
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
