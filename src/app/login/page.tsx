import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { LoginForm } from "./login-form";
import { PartnerLogos } from "./partner-logos";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="flex min-h-screen flex-col bg-background p-4">
      <PartnerLogos />

      <div className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-brand-foreground">
              <ShieldCheck className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">ICMS</h1>
            <p className="text-sm text-muted-foreground">
              Inflight Catering Management System
            </p>
          </div>

          {params.error === "no-profile" ? (
            <p className="rounded-md bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
              Your account has no ICMS profile. Contact an admin.
            </p>
          ) : null}
          {params.error === "pending" ? (
            <p className="rounded-md bg-amber-100 p-3 text-sm text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              Your registration is awaiting admin approval. You&apos;ll be able to sign in once
              it&apos;s approved.
            </p>
          ) : null}
          {params.error === "rejected" ? (
            <p className="rounded-md bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200">
              Your registration was not approved. Contact an admin for details.
            </p>
          ) : null}

          <LoginForm />

          <p className="text-center text-sm text-muted-foreground">
            New staff member?{" "}
            <Link href="/register" className="font-medium text-primary underline">
              Register here
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
