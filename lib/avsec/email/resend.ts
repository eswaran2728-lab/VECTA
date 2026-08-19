// Thin wrapper around the Resend API. Deliberately raw `fetch` (no SDK dependency) —
// mirrors the pattern already used for the Anthropic API call in the Smart Input route.
// Never throws: report submissions must never fail because an email failed to send.

const RESEND_FROM = process.env.RESEND_FROM_EMAIL || "AVSEC Reports <onboarding@resend.dev>";

export interface SendEmailResult {
  ok: boolean;
  error?: string;
}

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string | string[];
  subject: string;
  html: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `Resend API error ${response.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown email send error" };
  }
}
