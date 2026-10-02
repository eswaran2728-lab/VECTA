import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { listEntityRegistrationRequests } from "@/lib/avsec/admin/entity-registrations";
import { EntityRegistrationsView } from "@/components/avsec/admin/EntityRegistrationsView";

/**
 * MAA/AAX entity-admin registration page (Phase 13 correction). Gated by
 * an active is_entity_admin('MAA')/is_entity_admin('AAX') assignment --
 * NOT by legacy profiles.role -- so this is the one admin surface a
 * maa_admin/aax_admin can reach without ever being granted legacy
 * MANAGEMENT/ADMIN. Legacy MANAGEMENT/ADMIN keep their own separate
 * /avsec/admin/users page unchanged (not touched by this phase).
 */
export default async function EntityRegistrationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: isMaaAdmin }, { data: isAaxAdmin }] = await Promise.all([
    supabase.rpc("is_entity_admin", { p_entity_code: "MAA" }),
    supabase.rpc("is_entity_admin", { p_entity_code: "AAX" }),
  ]);

  if (!isMaaAdmin && !isAaxAdmin) {
    redirect("/?error=unauthorized-entity-admin");
  }

  const requests = await listEntityRegistrationRequests();

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-[0.03em] text-foreground">
            {isMaaAdmin && isAaxAdmin ? "MAA & AAX" : isMaaAdmin ? "MAA" : "AAX"} Registration Administration
          </h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Review and approve registration requests for your assigned entity. Cross-entity and cross-AOC requests
            never appear here.
          </p>
        </div>

        <EntityRegistrationsView requests={requests} />
      </div>
    </main>
  );
}
