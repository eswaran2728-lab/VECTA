"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setError(error.message);
      return;
    }
    setStatus("sent");
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm card p-6">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-brand-700 dark:text-brand-300">AVSEC OPS</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            AirAsia Aviation Security digital reporting
          </p>
        </div>

        {status === "sent" ? (
          <div className="text-center space-y-2">
            <p className="font-semibold">Check your email</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              We sent a sign-in link to <span className="font-medium">{email}</span>. Open it on
              this device to continue.
            </p>
            <button className="btn-quiet mt-2" onClick={() => setStatus("idle")}>
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
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
            {status === "error" && <p className="field-error">{error}</p>}
            <button type="submit" className="btn-primary w-full" disabled={status === "sending"}>
              {status === "sending" ? "Sending link…" : "Send sign-in link"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
