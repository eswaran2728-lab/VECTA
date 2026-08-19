"use client";

import { useState } from "react";
import { useActionState } from "react";
import { Mail, Lock, Eye, EyeOff, TriangleAlert } from "lucide-react";
import { signIn, type AuthState } from "@/lib/icms/actions/auth";
import { Button } from "@/components/icms/ui/button";
import { Card, CardContent } from "@/components/icms/ui/card";
import { Input } from "@/components/icms/ui/input";
import { Label } from "@/components/icms/ui/label";

const initialState: AuthState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="animate-border-glow rounded-[calc(var(--radius)+2px)] p-px">
      <Card className="overflow-hidden border-white/10 bg-card/70 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                className="pl-10"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                className="pl-10 pr-10"
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
            <p role="alert" className="flex items-center gap-1.5 text-sm text-red-400">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {state.error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending}
            className="animate-shimmer w-full bg-[linear-gradient(110deg,hsl(var(--primary))_40%,hsl(var(--primary)/0.65)_50%,hsl(var(--primary))_60%)] font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:shadow-primary/40 hover:brightness-105 active:scale-[0.99]"
          >
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
