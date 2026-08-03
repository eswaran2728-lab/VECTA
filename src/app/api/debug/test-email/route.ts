import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email/resend";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";

// Temporary diagnostic route to trace the admin-notification email path in production
// without needing Vercel log access. Requires being signed in. Safe to delete once the
// email issue is confirmed fixed.
export async function GET() {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, step: "auth", error: "Not signed in" }, { status: 401 });
  }

  const hasApiKey = Boolean(process.env.RESEND_API_KEY);

  const supabase = createClient();
  const { data: adminEmails, error: rpcError } = await supabase.rpc("get_admin_emails");

  if (rpcError) {
    return NextResponse.json({
      ok: false,
      step: "get_admin_emails",
      hasApiKey,
      error: rpcError.message,
    });
  }
  if (!adminEmails || adminEmails.length === 0) {
    return NextResponse.json({
      ok: false,
      step: "get_admin_emails",
      hasApiKey,
      error: "RPC returned no admin emails",
      adminEmails,
    });
  }

  const result = await sendEmail({
    to: adminEmails as string[],
    subject: "AVSEC Reports - diagnostic test",
    html: "<p>This is a diagnostic email sent from /api/debug/test-email.</p>",
  });

  return NextResponse.json({
    ok: result.ok,
    step: "sendEmail",
    hasApiKey,
    adminEmails,
    error: result.error,
  });
}
