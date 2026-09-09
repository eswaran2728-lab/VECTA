"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, CheckCircle2, TriangleAlert, Loader2, ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PartnerLogos } from "../login/partner-logos";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setErrorMsg("Please enter your registered email address.");
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const supabase = createClient();
      const redirectUrl = `${window.location.origin}/reset-password`;

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: redirectUrl,
      });

      if (error) {
        setErrorMsg(error.message);
        setIsLoading(false);
        return;
      }

      setSuccess(true);
      setIsLoading(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to request password reset.");
      setIsLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-background px-5 py-5">
      {/* Glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 480px 340px at 20% -8%, oklch(0.62 0.2 300 / 0.28), transparent 60%), radial-gradient(ellipse 520px 380px at 85% 100%, oklch(0.78 0.14 220 / 0.22), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex items-center justify-between">
        <span className="vecta-eyebrow">VECTA // ACCOUNT.RECOVERY</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          OPS &middot; CATERLINK
        </span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-8">
        <div className="flex w-full max-w-[420px] flex-col gap-5">
          <div className="vecta-panel">
            <div className="mb-5 flex flex-col items-center gap-1.5 text-center">
              <h1 className="bg-gradient-to-r from-primary to-[var(--violet)] bg-clip-text font-display text-[26px] font-extrabold leading-none tracking-[0.08em] text-transparent">
                RESET PASSWORD
              </h1>
              <p className="mx-auto mt-2 max-w-[300px] font-mono text-[9px] tracking-[0.14em] text-muted-foreground">
                ENTER YOUR REGISTERED EMAIL TO RECEIVE PASSWORD RECOVERY INSTRUCTIONS
              </p>
            </div>

            <div className="mb-4 flex items-center justify-center gap-3">
              <PartnerLogos />
            </div>

            <div className="mb-5 h-px bg-gradient-to-r from-transparent via-border to-transparent" />

            {success ? (
              <div className="flex flex-col gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs text-emerald-300">
                <div className="flex items-center gap-2 font-semibold text-emerald-400">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <span>Reset Link Dispatched</span>
                </div>
                <p className="leading-relaxed text-foreground/90">
                  If an account exists for <strong className="font-mono text-white">{email}</strong>, a password recovery email has been sent. Please check your inbox and spam folder.
                </p>
                <div className="mt-2 flex items-center justify-between pt-2 border-t border-emerald-500/20">
                  <Link
                    href="/login"
                    className="flex items-center gap-1.5 font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Back to Sign In
                  </Link>
                  <button
                    type="button"
                    onClick={() => setSuccess(false)}
                    className="text-muted-foreground hover:text-foreground underline underline-offset-4"
                  >
                    Try another email
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="email" className="vecta-label flex items-center gap-1.5">
                    <Mail className="h-3 w-3 text-muted-foreground" />
                    Registered Email Address
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@airasia.com or driver@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="vecta-input"
                  />
                </div>

                {errorMsg ? (
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/15 p-3 text-xs font-medium text-red-300">
                    <TriangleAlert className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
                    <span>{errorMsg}</span>
                  </div>
                ) : null}

                <button
                  type="submit"
                  disabled={isLoading}
                  style={{ touchAction: "manipulation" }}
                  className="vecta-btn-primary mt-1 active:scale-[0.98] transition-transform duration-100 cursor-pointer flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin text-primary-foreground" />
                      <span>Sending Reset Link…</span>
                    </>
                  ) : (
                    <span>Send Password Reset Link</span>
                  )}
                </button>

                <div className="mt-2 text-center">
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ArrowLeft className="h-3 w-3" />
                    Remember your password? Sign In
                  </Link>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
