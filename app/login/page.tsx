import type { Metadata } from "next";
import { TriangleAlert, Clock3 } from "lucide-react";
import { LoginForm } from "./login-form";
import { PartnerLogos } from "./partner-logos";

export const metadata: Metadata = { title: "Sign in — VECTA" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="dark relative flex min-h-screen flex-col overflow-hidden bg-background px-5 py-5">
      {/* Radial cyan/violet glow wash, matching the mockup's .scene background. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 480px 340px at 20% -8%, oklch(0.62 0.2 300 / 0.28), transparent 60%), radial-gradient(ellipse 520px 380px at 85% 100%, oklch(0.78 0.14 220 / 0.22), transparent 60%)",
        }}
      />
      {/* Subtle CRT-style scanlines. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, oklch(1 0 0 / 0.012) 4px)",
        }}
      />

      <div className="relative z-10 flex items-center justify-between">
        <span className="vecta-eyebrow">VECTA // AUTH.SYS</span>
        <span className="font-mono text-[11px] text-muted-foreground" suppressHydrationWarning>
          {new Date().toISOString().slice(11, 19)} UTC
        </span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-8">
        <div className="flex w-full max-w-[400px] flex-col gap-5">
          <div className="vecta-panel">
            {/* Corner nodes. */}
            {[
              { top: "-3px", left: "-3px" },
              { top: "-3px", right: "-3px" },
              { bottom: "-3px", left: "-3px" },
              { bottom: "-3px", right: "-3px" },
            ].map((pos, i) => (
              <span
                key={i}
                className="absolute h-[6px] w-[6px] rounded-full bg-primary"
                style={{ ...pos, boxShadow: "0 0 8px 1px var(--cyan)" }}
              />
            ))}

            <div className="mb-6 flex flex-col items-center gap-1.5 text-center">
              <h1 className="bg-gradient-to-r from-primary to-[var(--violet)] bg-clip-text font-display text-[32px] font-extrabold leading-none tracking-[0.08em] text-transparent">
                VECTA
              </h1>
              <p className="mx-auto mt-2 max-w-[260px] font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
                VERSATILE &middot; ENFORCEMENT &middot; CONTINUITY &middot; TRACEABILITY &middot; AUDIT
              </p>
            </div>

            <div className="mb-[22px] h-px bg-gradient-to-r from-transparent via-border to-transparent" />

            <div className="mb-[26px] flex items-center justify-center gap-3.5">
              <PartnerLogos />
            </div>

            {params.error === "no-profile" ? (
              <div className="mb-4 flex items-start gap-2 border border-brand/30 bg-brand/10 p-3 text-sm text-brand">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Your account has no VECTA profile. Contact an admin.</span>
              </div>
            ) : null}
            {params.error === "pending" ? (
              <div className="mb-4 flex items-start gap-2 border border-primary/30 bg-primary/10 p-3 text-sm text-primary">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Your registration is awaiting admin approval. You&apos;ll be able to sign in once
                  it&apos;s approved.
                </span>
              </div>
            ) : null}
            {params.error === "rejected" ? (
              <div className="mb-4 flex items-start gap-2 border border-brand/30 bg-brand/10 p-3 text-sm text-brand">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Your registration was not approved. Contact an admin for details.</span>
              </div>
            ) : null}

            {/*
              No self-registration: accounts are created only by an
              admin/management user via the Admin panel
              (/avsec/admin/users, app/(icms)/icms/admin/users). Full SSO
              via AirAsia's Google Workspace domain is planned as a future
              replacement for Supabase email/password auth, but that's a
              later migration — for now Supabase auth continues, just
              without any self-service path to create an account.
            */}
            <LoginForm />

            <div className="mt-[22px] flex items-center justify-center gap-2">
              <span className="vecta-status">
                <span className="vecta-status-dot" />
                System Nominal
              </span>
            </div>
          </div>

          <p className="text-center font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
            Accounts are provisioned by Admin &middot; No self-registration
          </p>
        </div>
      </div>
    </main>
  );
}
