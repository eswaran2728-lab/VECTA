import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck, TriangleAlert, Clock3 } from "lucide-react";
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
        <div className="absolute -left-32 -top-32 h-[26rem] w-[26rem] rounded-full bg-brand/25 blur-[120px]" />
        <div className="absolute -bottom-40 -right-24 h-[30rem] w-[30rem] rounded-full bg-primary/20 blur-[140px]" />
        <div className="absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-primary/10 blur-[110px]" />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      <div className="relative z-10 flex flex-1 flex-col p-4 sm:p-6">
        <PartnerLogos />

        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm space-y-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-primary shadow-lg shadow-brand/30">
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-brand to-primary opacity-50 blur-lg" />
                <ShieldCheck className="relative h-8 w-8 text-white" />
              </div>
              <div>
                <h1 className="font-heading bg-gradient-to-r from-foreground to-foreground/60 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent">
                  ICMS
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Inflight Catering Management System
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-primary">
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

            <LoginForm />

            <p className="text-center text-sm text-muted-foreground">
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
