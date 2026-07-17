import type { Metadata } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { RegisterForm } from "./register-form";
import { PartnerLogos } from "../login/partner-logos";

export const metadata: Metadata = { title: "Register" };

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background p-4">
      <PartnerLogos />

      <div className="flex flex-1 items-center justify-center py-8">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-brand-foreground">
              <UserPlus className="h-8 w-8" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Staff Registration</h1>
            <p className="text-sm text-muted-foreground">
              Your account will need admin approval before you can sign in.
            </p>
          </div>

          <RegisterForm />

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-primary underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
