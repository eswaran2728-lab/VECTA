import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { approveUser, rejectUser } from "@/lib/avsec/admin/actions";
import { CreateAccountForm } from "@/components/avsec/admin/CreateAccountForm";
import { UsersTable } from "@/components/avsec/admin/UsersTable";
import { ROLE_LABELS } from "@/lib/avsec/reference-data";
import type { Profile } from "@/lib/avsec/types";

export default async function AdminUsersPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(ADMIN_ROLES);

  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const profiles = (data as unknown as Profile[]) ?? [];

  const pending = profiles.filter((p) => p.status === "pending");
  const reviewed = profiles.filter((p) => p.status !== "pending");

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-[0.03em] text-foreground">User Management</h1>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              Create staff accounts, approve registrations, and assign checkpoint roles.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Link href="/avsec/admin/roster" className="btn-secondary">
              Team Roster
            </Link>
            <Link href="/avsec/admin/zones" className="btn-secondary">
              Duty Zones
            </Link>
          </div>
        </div>

        {searchParams.error && (
          <div className="card p-4 border-destructive/40 bg-destructive/10 text-destructive">
            <p className="text-sm font-medium">{searchParams.error}</p>
          </div>
        )}

        <CreateAccountForm />

        {pending.length > 0 && (
          <section className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-title">Pending approval</h2>
              <span className="font-mono text-xs text-muted-foreground">{pending.length} waiting</span>
            </div>
            <div className="divide-y divide-border">
              {pending.map((p) => (
                <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-foreground truncate">{p.name || p.email}</p>
                    <p className="font-mono text-xs text-muted-foreground truncate">
                      {p.email} · {p.staff_no} · {p.station} · {p.team}
                    </p>
                    <p className="font-mono text-xs text-primary font-semibold mt-1">
                      Requested: {ROLE_LABELS[p.role]}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <form action={approveUser}>
                      <input type="hidden" name="profileId" value={p.id} />
                      <button type="submit" className="btn-primary py-2 px-3 text-xs">
                        Approve
                      </button>
                    </form>
                    <form action={rejectUser}>
                      <input type="hidden" name="profileId" value={p.id} />
                      <button type="submit" className="btn-secondary py-2 px-3 text-xs">
                        Reject
                      </button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <UsersTable users={reviewed} />
      </div>
    </main>
  );
}
