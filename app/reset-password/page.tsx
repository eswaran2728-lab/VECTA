"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Lock, Eye, EyeOff, CheckCircle2, TriangleAlert, Loader2, ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { PartnerLogos } from "../login/partner-logos";

export default function ResetPasswordPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        setHasSession(Boolean(session));
      } catch {
        setHasSession(false);
      } finally {
        setSessionChecked(true);
      }
    };
    checkSession();
  }, []);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setErrorMsg("Password must be at least 8 characters long.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMsg("Passwords do not match. Please verify.");
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setErrorMsg(error.message);
        setIsLoading(false);
        return;
      }

      setSuccess(true);
      setIsLoading(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to update password.");
      setIsLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-background px-5 py-5">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 480px 340px at 20% -8%, oklch(0.62 0.2 300 / 0.28), transparent 60%), radial-gradient(ellipse 520px 380px at 85% 100%, oklch(0.78 0.14 220 / 0.22), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex items-center justify-between">
        <span className="vecta-eyebrow">VECTA // ACCOUNT.SECURITY</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          OPS &middot; CATERLINK
        </span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-8">
        <div className="flex w-full max-w-[420px] flex-col gap-5">
          <div className="vecta-panel">
            <div className="mb-5 flex flex-col items-center gap-1.5 text-center">
              <h1 className="bg-gradient-to-r from-primary to-[var(--violet)] bg-clip-text font-display text-[26px] font-extrabold leading-none tracking-[0.08em] text-transparent">
                SET NEW PASSWORD
              </h1>
              <p className="mx-auto mt-2 max-w-[300px] font-mono text-[9px] tracking-[0.14em] text-muted-foreground">
                CREATE A NEW SECURE PASSWORD FOR YOUR ACCOUNT
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
                  <span>Password Updated Successfully!</span>
                </div>
                <p className="leading-relaxed text-foreground/90">
                  Your new password is now active. You can now sign in using your new credentials.
                </p>
                <div className="mt-2 pt-2 border-t border-emerald-500/20">
                  <Link
                    href="/login"
                    className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 px-4 font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    <span>Proceed to Sign In</span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="new-password" className="vecta-label flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-muted-foreground" />
                    New Password
                  </label>
                  <div className="relative">
                    <input
                      id="new-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      placeholder="Minimum 8 characters"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      minLength={8}
                      className="vecta-input pr-10 tracking-[0.2em]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirm-password" className="vecta-label flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-muted-foreground" />
                    Confirm New Password
                  </label>
                  <input
                    id="confirm-password"
                    name="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    className="vecta-input tracking-[0.2em]"
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
                      <span>Updating Password…</span>
                    </>
                  ) : (
                    <span>Set New Password</span>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
