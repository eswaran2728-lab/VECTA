import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "./register-form";
import { PartnerLogos } from "../login/partner-logos";

export const metadata: Metadata = { title: "Register Account — VECTA & CaterLink" };

export default function RegisterPage() {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-background px-4 py-6">
      {/* Background glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 550px 380px at 20% -8%, oklch(0.62 0.2 300 / 0.25), transparent 60%), radial-gradient(ellipse 580px 420px at 85% 100%, oklch(0.78 0.14 220 / 0.20), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex items-center justify-between">
        <span className="vecta-eyebrow">VECTA // ONBOARDING.PORTAL</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          OPS &middot; CATERLINK v2.0
        </span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-6">
        <div className="flex w-full max-w-[480px] flex-col gap-4">
          <div className="vecta-panel">
            <div className="mb-4 flex flex-col items-center gap-1 text-center">
              <h1 className="bg-gradient-to-r from-primary to-[var(--violet)] bg-clip-text font-display text-[26px] font-extrabold leading-none tracking-[0.08em] text-transparent">
                ACCOUNT REGISTRATION
              </h1>
              <p className="font-mono text-[9.5px] tracking-[0.14em] text-muted-foreground">
                AIRASIA AVSEC &middot; CATERLINK DRIVER MOVEMENT
              </p>
            </div>

            <div className="mb-4 flex items-center justify-center gap-3">
              <PartnerLogos />
            </div>

            <div className="mb-4 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

            <RegisterForm />

            <div className="mt-5 text-center text-xs text-muted-foreground">
              Already have an approved account?{" "}
              <Link href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
                Sign in here
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
