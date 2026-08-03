"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/branding";

type Mode = "signin" | "signup" | "forgot";
type Status = "idle" | "working" | "error" | "checkEmail";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  function resetMessages() {
    setStatus("idle");
    setError("");
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPassword("");
    setConfirmPassword("");
    resetMessages();
  }

  async function handleSignIn(e: FormEvent) {
    e.preventDefault();
    setStatus("working");
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setStatus("error");
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function handleSignUp(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 6) {
      setStatus("error");
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setStatus("error");
      setError("Passwords don't match.");
      return;
    }

    setStatus("working");
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setError(error.message);
      return;
    }

    if (data.session) {
      // Email confirmation is off for this project — signed in immediately.
      router.push("/");
      router.refresh();
      return;
    }

    setStatus("checkEmail");
  }

  async function handleForgotPassword(e: FormEvent) {
    e.preventDefault();
    setStatus("working");
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password`,
    });

    if (error) {
      setStatus("error");
      setError(error.message);
      return;
    }
    setStatus("checkEmail");
  }

  const heading =
    mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Reset password";

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm card p-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-brand-700 dark:text-brand-300">{APP_NAME}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            AirAsia Aviation Security digital reporting
          </p>
        </div>

        {status === "checkEmail" ? (
          <div className="text-center space-y-2">
            <p className="font-semibold">Check your email</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {mode === "forgot"
                ? `We sent a password reset link to ${email}.`
                : `We sent a confirmation link to ${email}. Open it on this device to activate your account.`}
            </p>
            <button className="btn-quiet mt-2" onClick={() => switchMode("signin")}>
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-4">{heading}</h2>
            <form
              onSubmit={
                mode === "signin" ? handleSignIn : mode === "signup" ? handleSignUp : handleForgotPassword
              }
              className="space-y-4"
            >
              <div>
                <label className="field-label" htmlFor="email">
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  className="input-base"
                  placeholder="you@airasia.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {mode !== "forgot" && (
                <div>
                  <label className="field-label" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={6}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    className="input-base"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}

              {mode === "signup" && (
                <div>
                  <label className="field-label" htmlFor="confirmPassword">
                    Confirm password
                  </label>
                  <input
                    id="confirmPassword"
                    type="password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="input-base"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              )}

              {mode === "signin" && (
                <button
                  type="button"
                  className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                  onClick={() => switchMode("forgot")}
                >
                  Forgot password?
                </button>
              )}

              {status === "error" && <p className="field-error">{error}</p>}

              <button type="submit" className="btn-primary w-full" disabled={status === "working"}>
                {status === "working"
                  ? "Please wait…"
                  : mode === "signin"
                    ? "Sign in"
                    : mode === "signup"
                      ? "Create account"
                      : "Send reset link"}
              </button>
            </form>

            <div className="text-center mt-4 text-sm text-slate-500 dark:text-slate-400">
              {mode === "signin" && (
                <button className="text-brand-600 dark:text-brand-400 font-medium hover:underline" onClick={() => switchMode("signup")}>
                  New here? Create an account
                </button>
              )}
              {mode === "signup" && (
                <button className="text-brand-600 dark:text-brand-400 font-medium hover:underline" onClick={() => switchMode("signin")}>
                  Already have an account? Sign in
                </button>
              )}
              {mode === "forgot" && (
                <button className="text-brand-600 dark:text-brand-400 font-medium hover:underline" onClick={() => switchMode("signin")}>
                  Back to sign in
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
