"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Eye, EyeOff, TriangleAlert, ShieldCheck, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  const trimmed = next.trim();
  if (
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("/\\") &&
    !trimmed.includes(":")
  ) {
    return trimmed;
  }
  return null;
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockoutSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutSeconds]);

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    setErrorMsg(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          queryParams: {
            access_type: "offline",
            prompt: "consent",
          },
        },
      });
      if (error) {
        setErrorMsg(error.message);
        setIsGoogleLoading(false);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to initiate Google Sign-In");
      setIsGoogleLoading(false);
    }
  };

  const handleCredentialsSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutSeconds > 0) return;

    if (!email || !password) {
      setErrorMsg("Please enter both email and password.");
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error || !data.user) {
        const nextAttempts = failedAttempts + 1;
        setFailedAttempts(nextAttempts);

        // Security: Brute-force backoff after 5 attempts
        if (nextAttempts >= 5) {
          setLockoutSeconds(30);
          setErrorMsg("Too many failed login attempts. Please wait 30 seconds before retrying.");
        } else {
          // Security: Unified error message prevents user enumeration
          setErrorMsg("Invalid email or password.");
        }
        setIsLoading(false);
        return;
      }

      // Check safe next redirect
      const urlParams = new URLSearchParams(window.location.search);
      const safeNext = sanitizeNext(urlParams.get("next"));

      // Check user role for routing
      const userEmail = (data.user.email ?? "").toLowerCase();
      const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
      const isCaterLinkUser =
        meta.system_type === "caterlink" ||
        meta.role === "vendor" ||
        meta.driver_type !== undefined ||
        userEmail.endsWith("@caterlink.internal") ||
        userEmail.includes("caterlink") ||
        userEmail.includes("driver") ||
        userEmail.includes("warehouse") ||
        userEmail.includes("vendor");

      if (safeNext) {
        window.location.href = safeNext;
      } else if (isCaterLinkUser) {
        window.location.href = "/caterlink/dashboard";
      } else {
        window.location.href = "/";
      }
    } catch (err) {
      setErrorMsg("Invalid email or password.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Primary Google / Corporate SSO Action */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={isGoogleLoading || isLoading}
          style={{ touchAction: "manipulation" }}
          className="relative flex w-full select-none items-center justify-center gap-3 rounded-lg border border-border/80 bg-surface/90 px-4 py-3.5 text-sm font-semibold tracking-wide text-foreground shadow-sm transition-all duration-100 hover:border-primary/60 hover:bg-surface active:scale-[0.98] active:opacity-85 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:pointer-events-none disabled:opacity-50 cursor-pointer"
        >
          {isGoogleLoading ? (
            <div className="flex items-center gap-2 font-mono text-xs text-primary">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>Connecting to Google…</span>
            </div>
          ) : (
            <>
              {/* Google 4-color SVG Icon */}
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.26v3.15C3.25 21.36 7.33 24 12 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.28 14.27a7.22 7.22 0 0 1 0-4.54V6.58H1.26a11.97 11.97 0 0 0 0 10.84l4.02-3.15z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.25 2.64 1.26 6.58l4.02 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
                />
              </svg>
              <span>Sign in with Google / SSO</span>
            </>
          )}
        </button>

        <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          <span>AirAsia AVSEC Operational SSO Ready</span>
        </div>
      </div>

      {/* Divider */}
      <div className="my-1 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/60" />
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/80">
          or password sign-in
        </span>
        <div className="h-px flex-1 bg-border/60" />
      </div>

      {/* Standard Email/Password Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCredentialsSignIn(e);
        }}
        action="#"
        method="dialog"
        className="flex flex-col gap-3.5"
      >
        <div>
          <label htmlFor="email" className="vecta-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@airasia.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCredentialsSignIn(e);
              }
            }}
            required
            className="vecta-input"
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="vecta-label">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-xs text-primary underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCredentialsSignIn(e);
                }
              }}
              required
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
        {errorMsg ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-brand">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            {errorMsg}
          </p>
        ) : null}
        <button
          type="button"
          onClick={handleCredentialsSignIn}
          disabled={isLoading || isGoogleLoading || lockoutSeconds > 0}
          style={{ touchAction: "manipulation" }}
          className="vecta-btn-primary mt-1 active:scale-[0.98] transition-transform duration-100 cursor-pointer"
        >
          {lockoutSeconds > 0
            ? `Locked (${lockoutSeconds}s)`
            : isLoading
            ? "Signing in…"
            : "Sign in with Credentials"}
        </button>
      </form>
    </div>
  );
}
