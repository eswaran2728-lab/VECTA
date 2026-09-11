import { redirect } from "next/navigation";
import { getCurrentProfile, landingPathForRole } from "@/lib/avsec/auth";
import { signOut } from "@/lib/avsec/profile-actions";
import { ROLE_LABELS } from "@/lib/avsec/reference-data";
import { APP_NAME } from "@/lib/avsec/branding";

export default async function PendingApprovalPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) redirect("/avsec/profile-setup");
  if (profile.status === "approved") redirect(landingPathForRole(profile.role));

  const rejected = profile.status === "rejected";
  const deactivated = profile.status === "deactivated";

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm card p-6 text-center space-y-4">
        <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">{APP_NAME}</h1>
        {deactivated ? (
          <>
            <p className="font-semibold text-destructive font-mono text-xs uppercase tracking-wider">Account deactivated</p>
            <p className="font-mono text-xs text-muted-foreground">
              Your access to {APP_NAME} has been deactivated. Contact your administrator if you
              believe this is a mistake.
            </p>
          </>
        ) : rejected ? (
          <>
            <p className="font-semibold text-destructive font-mono text-xs uppercase tracking-wider">Access request declined</p>
            <p className="font-mono text-xs text-muted-foreground">
              Your account request was not approved. Contact your administrator if you believe this
              is a mistake.
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-primary font-mono text-xs uppercase tracking-wider">Waiting for admin approval</p>
            <p className="font-mono text-xs text-muted-foreground">
              You requested access as <strong className="text-foreground">{ROLE_LABELS[profile.role]}</strong>. An admin needs to
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
