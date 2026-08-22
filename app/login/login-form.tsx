"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import { signIn, type AuthState } from "@/lib/icms/actions/auth";

const initialState: AuthState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
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
          required
          className="vecta-input"
        />
      </div>
      <div>
        <label htmlFor="password" className="vecta-label">
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
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
      {state.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-brand">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="vecta-btn-primary mt-1">
        {pending ? "Signing in…" : "Sign in to VECTA"}
      </button>
    </form>
  );
}
