import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
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
      <AppHeader profile={profile} title="User Management" backHref="/avsec/dashboard" />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">User Management</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
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
          <div className="card p-4 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{searchParams.error}</p>
          </div>
        )}

        <CreateAccountForm />

        {pending.length > 0 && (
          <section className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="section-title">Pending approval</h2>
              <span className="text-xs text-slate-500">{pending.length} waiting</span>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {pending.map((p) => (
                <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{p.name || p.email}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {p.email} · {p.staff_no} · {p.station} · {p.team}
                    </p>
                    <p className="text-xs text-brand-600 dark:text-brand-400 font-semibold mt-1">
                      Requested: {ROLE_LABELS[p.role]}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <form action={approveUser}>
                      <input type="hidden" name="profileId" value={p.id} />
                      <button type="submit" className="btn-primary py-2 px-3 text-sm">
                        Approve
                      </button>
                    </form>
                    <form action={rejectUser}>
                      <input type="hidden" name="profileId" value={p.id} />
                      <button type="submit" className="btn-secondary py-2 px-3 text-sm">
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
