import { redirect } from "next/navigation";
import { getCurrentProfile, landingPathForRole } from "@/lib/auth";
import { signOut } from "@/lib/profile-actions";
import { ROLE_LABELS } from "@/lib/reference-data";
import { APP_NAME } from "@/lib/branding";

export default async function PendingApprovalPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) redirect("/profile-setup");
  if (profile.status === "approved") redirect(landingPathForRole(profile.role));

  const rejected = profile.status === "rejected";

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm card p-6 text-center space-y-3">
        <h1 className="text-xl font-bold">{APP_NAME}</h1>
        {rejected ? (
          <>
            <p className="font-semibold text-red-600 dark:text-red-400">Access request declined</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Your account request was not approved. Contact your administrator if you believe this
              is a mistake.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold">Waiting for admin approval</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              You requested access as <strong>{ROLE_LABELS[profile.role]}</strong>. An admin needs to
              approve your account before you can use {APP_NAME}. Try again later.
            </p>
          </>
        )}
        <form action={signOut} className="pt-2">
          <button type="submit" className="btn-secondary w-full">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
