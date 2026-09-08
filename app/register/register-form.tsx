"use client";

import { useActionState } from "react";
import Link from "next/link";
import { registerDriver, type RegisterState } from "@/lib/icms/actions/registration";
import { TriangleAlert, CheckCircle2 } from "lucide-react";

const initialState: RegisterState = { error: null, success: null };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerDriver, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <div>
        <label htmlFor="name" className="vecta-label">
          Full Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          placeholder="Ahmad bin Ali"
          required
          className="vecta-input"
        />
      </div>

      <div>
        <label htmlFor="staff_id" className="vecta-label">
          Driver ID / NRIC Number
        </label>
        <input
          id="staff_id"
          name="staff_id"
          type="text"
          placeholder="DRV-1029 / 950101-14-1234"
          required
          className="vecta-input"
        />
      </div>

      <div>
        <label htmlFor="email" className="vecta-label">
          Email Address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="driver@catering.com"
          required
          className="vecta-input"
        />
      </div>

      <div>
        <label htmlFor="password" className="vecta-label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="Minimum 8 characters"
          required
          minLength={8}
          className="vecta-input tracking-widest"
        />
      </div>

      {state.error ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-brand">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Registration Successful!</span>
          </div>
          <p>{state.success}</p>
          <Link
            href="/login"
            className="mt-1 font-semibold text-primary underline underline-offset-4"
          >
            Click here to Sign In ➔
          </Link>
        </div>
      ) : (
        <button
          type="submit"
          disabled={pending}
          className="vecta-btn-primary mt-2 active:scale-[0.98] transition-transform"
        >
          {pending ? "Registering Driver…" : "Register Driver Account"}
        </button>
      )}
    </form>
  );
}
