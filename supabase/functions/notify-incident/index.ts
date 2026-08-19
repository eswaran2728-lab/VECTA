// CSCS incident email notifier (Supabase Edge Function).
//
// Wire-up (optional — in-app notifications work without this):
//   1. supabase secrets set RESEND_API_KEY=re_xxx NOTIFY_FROM=alerts@yourdomain.com
//   2. supabase functions deploy notify-incident
//   3. Database Webhook: on INSERT into public.incidents -> this function.
//
// The sender is channel-agnostic: add a TelegramChannel next to EmailChannel
// and push it into `channels` to fan out to more destinations.

interface IncidentPayload {
  record: {
    id: string;
    transaction_id: string;
    incident_type: string;
    description: string;
    reported_by: string;
    created_at: string;
  };
}

interface Channel {
  send(subject: string, body: string, recipients: string[]): Promise<void>;
}

class EmailChannel implements Channel {
  async send(subject: string, body: string, recipients: string[]): Promise<void> {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("NOTIFY_FROM") ?? "cscs-alerts@example.com";
    if (!apiKey) {
      console.warn("RESEND_API_KEY not set - skipping email");
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, text: body }),
    });
    if (!res.ok) {
      console.error("Resend error", res.status, await res.text());
    }
  }
}

// Future: class TelegramChannel implements Channel { ... }
const channels: Channel[] = [new EmailChannel()];

Deno.serve(async (req) => {
  try {
    const payload = (await req.json()) as IncidentPayload;
    const incident = payload.record;

    // Supervisor emails via the service-role REST API.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetch(
      `${supabaseUrl}/rest/v1/users?role=eq.supervisor&select=email`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const supervisors = (await res.json()) as { email: string }[];
    const recipients = supervisors.map((s) => s.email);
    if (recipients.length === 0) {
      return new Response("no supervisors", { status: 200 });
    }

    const subject = `CSCS incident: ${incident.incident_type}`;
    const body =
      `An incident was reported and the transaction escalated.\n\n` +
      `Type: ${incident.incident_type}\n` +
      `Reported by: ${incident.reported_by}\n` +
      `At: ${incident.created_at}\n\n` +
      `${incident.description}`;

    await Promise.all(channels.map((c) => c.send(subject, body, recipients)));
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
