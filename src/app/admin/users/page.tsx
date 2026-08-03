import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/layout/AppHeader";
import { approveUser, rejectUser } from "@/lib/admin/actions";
import { ROLE_LABELS } from "@/lib/reference-data";
import { formatDateTimeMY } from "@/lib/datetime";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/utils";

export default async function AdminUsersPage() {
  const profile = await requireRole(ADMIN_ROLES);

  const supabase = createClient();
  const { data } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  const profiles = (data as Profile[]) ?? [];

  const pending = profiles.filter((p) => p.status === "pending");
  const reviewed = profiles.filter((p) => p.status !== "pending");

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Manage users" backHref="/dashboard" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <section className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-title">Pending approval</h2>
            <span className="text-xs text-slate-500">{pending.length} waiting</span>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {pending.length === 0 && (
              <p className="py-2 text-sm text-slate-500 dark:text-slate-400">No pending requests.</p>
            )}
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

        <section className="card p-4">
          <h2 className="section-title mb-3">All users</h2>
          <div className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
            {reviewed.map((p) => (
              <div key={p.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.name || p.email}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {p.email} · {ROLE_LABELS[p.role]} · {p.station}
                  </p>
                </div>
                <span
                  className={cn(
                    "text-xs font-bold px-2 py-1 rounded-full shrink-0",
                    p.status === "approved"
                      ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
                      : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
                  )}
                >
                  {p.status.toUpperCase()}
                </span>
              </div>
            ))}
            {reviewed.length === 0 && <p className="py-2 text-slate-500">No reviewed users yet.</p>}
          </div>
        </section>

        <p className="text-xs text-slate-400">
          Last synced {formatDateTimeMY(new Date().toISOString())}
        </p>
      </div>
    </main>
  );
}
