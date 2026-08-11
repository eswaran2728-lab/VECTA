"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { APP_NAME } from "@/lib/branding";
import { STATIONS, REQUESTABLE_ROLES, ROLE_LABELS, ORG_WIDE_ROLES, type UserRole } from "@/lib/reference-data";

type Mode = "signin" | "signup" | "forgot";
type Status = "idle" | "working" | "error" | "checkEmail";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [staffNo, setStaffNo] = useState("");
  const [station, setStation] = useState("");
  const [team, setTeam] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const isOrgWideRole = (ORG_WIDE_ROLES as readonly string[]).includes(role);

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
    if (!name.trim() || !station || !role) {
      setStatus("error");
      setError("Please fill in your name, station and role.");
      return;
    }
    if (!isOrgWideRole && (!staffNo.trim() || !team.trim())) {
      setStatus("error");
      setError("Staff No and Team are required for this role.");
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

    if (data.session && data.user) {
      const { error: profileError } = await supabase
        .from("profiles")
        .update({
          name: name.trim(),
          staff_no: isOrgWideRole ? "" : staffNo.trim(),
          station,
          team: isOrgWideRole ? "" : team.trim(),
          role,
        })
        .eq("id", data.user.id);

      if (profileError) {
        setStatus("error");
        setError(profileError.message);
        return;
      }

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
      <div className={`w-full card p-6 ${mode === "signup" ? "max-w-md" : "max-w-sm"}`}>
        <div className="text-center mb-6">
          <Image
            src="/icons/icon-192.png"
            alt="AVSEC AirAsia"
            width={80}
            height={80}
            className="mx-auto rounded-2xl mb-3"
            priority
          />
          <h1 className="text-2xl font-bold text-brand-700 dark:text-brand-400">{APP_NAME}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            AirAsia Aviation Security digital reporting
          </p>
          <Image
            src="/icons/airasia-logo.png"
            alt="AirAsia"
            width={28}
            height={28}
            className="mx-auto mt-3 rounded-full"
          />
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
                <>
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

                  <div>
                    <label className="field-label" htmlFor="name">
                      Full name
                    </label>
                    <input
                      id="name"
                      required
                      className="input-base"
                      placeholder="As per staff ID"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="field-label" htmlFor="station">
                      Station
                    </label>
                    <select
                      id="station"
                      required
                      className="input-base"
                      value={station}
                      onChange={(e) => setStation(e.target.value)}
                    >
                      <option value="" disabled>
                        Select station
                      </option>
                      {STATIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="field-label" htmlFor="role">
                      Role
                    </label>
                    <select
                      id="role"
                      required
                      className="input-base"
                      value={role}
                      onChange={(e) => setRole(e.target.value as UserRole)}
                    >
                      <option value="" disabled>
                        Select role
                      </option>
                      {REQUESTABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>

                  {!isOrgWideRole && (
                    <>
                      <div>
                        <label className="field-label" htmlFor="staffNo">
                          Staff No / ID
                        </label>
                        <input
                          id="staffNo"
                          required
                          className="input-base"
                          value={staffNo}
                          onChange={(e) => setStaffNo(e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="field-label" htmlFor="team">
                          Team
                        </label>
                        <input
                          id="team"
                          required
                          className="input-base"
                          placeholder="e.g. Alpha"
                          value={team}
                          onChange={(e) => setTeam(e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  <p className="field-hint">
                    ASO submits reports. SO and DSE monitor and acknowledge their own team&apos;s
                    reports. Enforcement and Management Team monitor every team. Your account needs
                    Admin approval before you can sign in.
                  </p>
                </>
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
