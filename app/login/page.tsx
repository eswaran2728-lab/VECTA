import type { Metadata } from "next";
import Link from "next/link";
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
    <main className="dark flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="vecta-panel">
          <div className="mb-7 text-center">
            <h1 className="font-sans text-[38px] font-black leading-none tracking-[0.06em] text-foreground">
              VECTA
            </h1>
            <p className="mx-auto mt-2.5 max-w-[260px] font-sans text-[9.5px] font-semibold uppercase leading-relaxed tracking-[0.13em] text-muted-foreground">
              Versatile Enforcement, Continuity, Traceability &amp; Audit
            </p>
          </div>

          <div className="my-5 h-px bg-white/[0.08]" />

          <div className="mb-8 flex items-center justify-center gap-3.5">
            <PartnerLogos />
          </div>

          {params.error === "no-profile" ? (
            <div className="mb-4 flex items-start gap-2 border border-brand/20 bg-brand/10 p-3 text-sm text-brand">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Your account has no VECTA profile. Contact an admin.</span>
            </div>
          ) : null}
          {params.error === "pending" ? (
            <div className="mb-4 flex items-start gap-2 border border-primary/20 bg-primary/10 p-3 text-sm text-primary">
              <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Your registration is awaiting admin approval. You&apos;ll be able to sign in once
                it&apos;s approved.
              </span>
            </div>
          ) : null}
          {params.error === "rejected" ? (
            <div className="mb-4 flex items-start gap-2 border border-brand/20 bg-brand/10 p-3 text-sm text-brand">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Your registration was not approved. Contact an admin for details.</span>
            </div>
          ) : null}

          <LoginForm />

          <div className="mt-7 flex items-center justify-center gap-4">
            <span className="vecta-status">
              <span className="vecta-status-dot" />
              SYSTEM NOMINAL
            </span>
          </div>
        </div>

        <p className="mt-6 text-center font-sans text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          New staff member?{" "}
          <Link href="/icms/register" className="text-primary underline underline-offset-4">
            Register here
          </Link>
        </p>
      </div>
    </main>
  );
}
