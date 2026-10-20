import type { Metadata } from "next";
import { Clock3, Shield, TriangleAlert } from "lucide-react";

import { LoginForm } from "./login-form";
import { PartnerLogos } from "./partner-logos";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

export const metadata: Metadata = { title: "Sign in — VECTA" };

type Notice = { tone: "warning" | "danger" | "info"; icon: "alert" | "clock"; body: React.ReactNode };

const NOTICE_TONE: Record<Notice["tone"], string> = {
  warning: "border-warning/40 bg-warning/10 text-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-foreground",
  info: "border-primary/40 bg-primary/10 text-foreground",
};
const NOTICE_ICON: Record<Notice["tone"], string> = { warning: "text-warning", danger: "text-destructive", info: "text-primary" };

function noticeFor(error: string | undefined): Notice | null {
  switch (error) {
    case "caterlink-only":
      return {
        tone: "warning",
        icon: "alert",
        body: (
          <>
            This account is registered for <strong>CaterLink Driver/Vendor</strong> access only. Please sign in through the CaterLink portal.
          </>
        ),
      };
    case "auth-code-error":
      return { tone: "danger", icon: "alert", body: "Google authentication failed or expired. Please try signing in again." };
    case "no-profile":
      return { tone: "danger", icon: "alert", body: "Your account has no VECTA profile. Contact an admin." };
    case "pending":
      return { tone: "info", icon: "clock", body: "Your registration is awaiting admin approval. You'll be able to sign in once it's approved." };
    case "rejected":
      return { tone: "danger", icon: "alert", body: "Your registration was not approved. Contact an admin for details." };
    default:
      return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const notice = noticeFor(params.error);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex min-h-[64px] items-center justify-between bg-shell px-5 text-shell-foreground">
        <span className="flex items-center gap-2.5">
          <Shield className="h-5 w-5 text-shell-active" aria-hidden />
          <span className="text-base font-extrabold tracking-wide">VECTA</span>
        </span>
        <ThemeToggle tone="shell" />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center">
        <div className="flex w-full max-w-[420px] flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-[var(--shadow-card)] sm:p-8">
            <div className="mb-6 text-center">
              <h1 className="text-3xl font-extrabold tracking-wide text-foreground">VECTA</h1>
              <p className="mx-auto mt-2 max-w-[300px] text-xs font-medium leading-relaxed text-muted-foreground">
                Versatile &middot; Enforcement &middot; Continuity &middot; Traceability &middot; Audit
              </p>
            </div>

            <div className="mb-6 flex items-center justify-center gap-3.5">
              <PartnerLogos />
            </div>

            {notice ? (
              <div role="alert" className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${NOTICE_TONE[notice.tone]}`}>
                {notice.icon === "clock" ? (
                  <Clock3 className={`mt-0.5 h-4 w-4 shrink-0 ${NOTICE_ICON[notice.tone]}`} aria-hidden />
                ) : (
                  <TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${NOTICE_ICON[notice.tone]}`} aria-hidden />
                )}
                <span>{notice.body}</span>
              </div>
            ) : null}

            {/*
              No self-registration for AVSEC staff: accounts are created only by an admin/management user via the Admin panel
              (/avsec/admin/users, app/(icms)/icms/admin/users). Google Workspace SSO and Supabase email/password both remain.
            */}
            <LoginForm />

            <div className="mt-4 border-t border-border pt-4 text-center">
              <p className="text-xs text-muted-foreground">
                New Catering Driver / Vendor?{" "}
                <a href="/register" className="inline-flex min-h-[44px] items-center font-semibold text-primary underline underline-offset-4 hover:opacity-80">
                  Register driver account
                </a>
              </p>
            </div>
          </div>

          <p className="text-center text-xs text-muted-foreground">AVSEC accounts are provisioned via SSO &middot; Driver self-registration is enabled</p>
        </div>
      </main>
    </div>
  );
}
