"use client";

import { useEffect, useState } from "react";
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
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [checkingLink, setCheckingLink] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkError = params.get("error");
    if (linkError) {
      setErrorMsg("This password-reset link is invalid or has expired. Request a new link and open the newest email.");
      setCheckingLink(false);
      return;
    }

    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const recoveryTokens = fragment.get("type") === "recovery"
      ? { access_token: fragment.get("access_token"), refresh_token: fragment.get("refresh_token") }
      : null;
    // Remove tokens from the address bar before rendering or making requests.
    if (window.location.hash) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    const supabase = createClient();

    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" && session) {
        setRecoveryReady(true);
        setCheckingLink(false);
      }
    });

    const establishSession = recoveryTokens?.access_token && recoveryTokens.refresh_token
      ? supabase.auth.setSession({ access_token: recoveryTokens.access_token, refresh_token: recoveryTokens.refresh_token })
      : supabase.auth.getSession();

    void establishSession.then(({ data, error }) => {
      if (!active) return;
      if (!error && data.session && recoveryTokens) {
        setRecoveryReady(true);
      }
      setCheckingLink(false);
    }).catch(() => {
      if (active) setCheckingLink(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recoveryReady) {
      setErrorMsg("This reset link has no active recovery session. Request a new link and open it in the same browser.");
      return;
    }
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
              <div className="flex flex-col gap-3 rounded-lg border border-success/30 bg-success/10 p-4 text-xs text-success">
                <div className="flex items-center gap-2 font-semibold text-success">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <span>Password Updated Successfully!</span>
                </div>
                <p className="leading-relaxed text-foreground/90">
                  Your new password is now active. You can now sign in using your new credentials.
                </p>
                <div className="mt-2 pt-2 border-t border-success/20">
                  <Link
                    href="/login"
                    className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 px-4 font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    <span>Proceed to Sign In</span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            ) : checkingLink ? (
              <p role="status" className="text-center text-sm text-muted-foreground">Checking your reset link…</p>
            ) : !recoveryReady ? (
              <div role="alert" className="flex flex-col gap-4 text-sm">
                <p className="text-destructive">{errorMsg ?? "This reset link cannot be used here. It may have expired or opened in a different browser."}</p>
                <Link href="/forgot-password" className="vecta-btn-primary text-center">Request a New Reset Link</Link>
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
                  <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/15 p-3 text-xs font-medium text-destructive">
                    <TriangleAlert className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
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
