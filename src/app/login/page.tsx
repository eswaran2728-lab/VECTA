import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <ShieldCheck className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">CSCS</h1>
          <p className="text-sm text-muted-foreground">
            Catering Security Control System
          </p>
        </div>

        {params.error === "no-profile" ? (
          <p className="rounded-md bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
            Your account has no CSCS profile. Contact a supervisor.
          </p>
        ) : null}

        <LoginForm />
      </div>
    </main>
  );
}
