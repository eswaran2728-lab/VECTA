import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, TriangleAlert, Clock3, Plane } from "lucide-react";
import { LoginForm } from "./login-form";
import { PartnerLogos } from "./partner-logos";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="dark relative flex min-h-screen flex-col overflow-hidden bg-background">
      {/* Ambient brand glow — purely decorative, sits behind everything. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-float-slow animate-glow-pulse absolute -left-32 -top-32 h-[26rem] w-[26rem] rounded-full bg-brand/25 blur-[120px]" />
        <div
          className="animate-float-slow animate-glow-pulse absolute -bottom-40 -right-24 h-[30rem] w-[30rem] rounded-full bg-primary/20 blur-[140px]"
          style={{ animationDelay: "-3s" }}
        />
        <div
          className="animate-float-slow absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-[110px]"
          style={{ animationDelay: "-6s" }}
        />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
        {/* A lone aircraft drifting across the sky, echoing the inflight theme. */}
        <div className="animate-fly absolute left-0 top-0">
          <Plane className="h-6 w-6 -rotate-45 text-primary/40" />
        </div>
      </div>

      <div className="relative z-10 flex flex-1 flex-col p-4 sm:p-6">
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm space-y-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <PartnerLogos />
              <div className="animate-fade-in-up" style={{ animationDelay: "350ms" }}>
                <h1 className="font-heading bg-gradient-to-r from-foreground to-foreground/60 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent">
                  ICMS
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Inflight Catering Management System
                </p>
              </div>
              <span
                className="animate-fade-in-up inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-primary"
                style={{ animationDelay: "450ms" }}
              >
                <ShieldCheck className="h-3 w-3" />
                Secure Access
              </span>
            </div>

            {params.error === "no-profile" ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Your account has no ICMS profile. Contact an admin.</span>
              </div>
            ) : null}
            {params.error === "pending" ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-300">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Your registration is awaiting admin approval. You&apos;ll be able to sign in once
                  it&apos;s approved.
                </span>
              </div>
            ) : null}
            {params.error === "rejected" ? (
              <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Your registration was not approved. Contact an admin for details.</span>
              </div>
            ) : null}

            <div className="animate-fade-in-up" style={{ animationDelay: "550ms" }}>
              <LoginForm />
            </div>

            <p
              className="animate-fade-in-up text-center text-sm text-muted-foreground"
              style={{ animationDelay: "650ms" }}
            >
              New staff member?{" "}
              <Link href="/register" className="font-medium text-primary underline underline-offset-4">
                Register here
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
