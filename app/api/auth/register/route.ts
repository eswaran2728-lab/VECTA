import { handleRegistration } from "@/lib/auth/registration";
import { registrationDeps } from "@/lib/auth/registration-runtime";

export const dynamic = "force-dynamic";

/**
 * Public self-registration. Everything that matters (allowlists, field limits, anti-automation, durable rate limiting, generic errors,
 * rollback) lives in lib/auth/registration.ts so it is tested without a server; this route only wires the real dependencies.
 */
export async function POST(request: Request) {
  return handleRegistration(request, registrationDeps());
}
