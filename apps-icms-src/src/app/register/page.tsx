import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "./register-form";
import { PartnerLogos } from "../login/partner-logos";

export const metadata: Metadata = { title: "Register" };

export default function RegisterPage() {
  return (
    <main className="dark relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-[26rem] w-[26rem] rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute -bottom-40 -right-24 h-[30rem] w-[30rem] rounded-full bg-brand/20 blur-[140px]" />
      </div>

      <div className="relative z-10 flex flex-1 flex-col p-4 sm:p-6">
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-sm space-y-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <PartnerLogos />
              <div>
                <h1 className="font-heading text-2xl font-bold tracking-tight">Staff Registration</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your account will need admin approval before you can sign in.
                </p>
              </div>
            </div>

            <RegisterForm />

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="font-medium text-primary underline underline-offset-4">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
