// AVSEC REPORTS -> Google Sheets one-way mirror.
//
// Invoked every 2 minutes by pg_cron (via pg_net, see migration 0023_sheet_sync_queue.sql),
// or on demand from /admin/sheet-sync's "Sync Now" button. Claims up to 50 pending rows from
// sheet_sync_queue, fetches the actual report data, POSTs them batched to a Google Apps
// Script Web App, and marks each row sent or failed.
//
// verify_jwt is disabled for this function (see deploy call) — it's a webhook-style
// function triggered by our own cron and admin action, not by end-user sessions, and
// implements its own auth: the caller must send the same X-Sync-Secret configured in
// sheet_sync_config, which is also what gets forwarded to the Apps Script Web App.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BATCH_SIZE = 50;

const TABLES: Record<string, string> = {
  sec016: "report_sec016",
  sec014: "report_sec014",
  sec029: "report_sec029",
  sec018: "report_sec018",
  sec033: "report_sec033",
  sec013: "report_sec013",
  offload: "offload_records",
};

interface QueueRow {
  id: string;
  report_type: string;
  report_id: string;
  attempts: number;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: cfg } = await supabase
      .from("sheet_sync_config")
      .select("webhook_url, webhook_secret, enabled")
      .eq("id", true)
      .maybeSingle();

    if (!cfg || !cfg.enabled || !cfg.webhook_url || !cfg.webhook_secret) {
      return jsonResponse({ ok: false, error: "Sheet sync is not configured or is disabled." });
    }

    const incomingSecret = req.headers.get("X-Sync-Secret");
    if (incomingSecret !== cfg.webhook_secret) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const { data: pending } = await supabase
      .from("sheet_sync_queue")
      .select("id, report_type, report_id, attempts")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    const items = (pending ?? []) as QueueRow[];
    if (items.length === 0) {
      return jsonResponse({ ok: true, sent: 0 });
    }

    // One query per report_type present in this batch, not one per row.
    const idsByType = new Map<string, string[]>();
    for (const item of items) {
      const list = idsByType.get(item.report_type) ?? [];
      list.push(item.report_id);
      idsByType.set(item.report_type, list);
    }

    const rowsByKey = new Map<string, Record<string, unknown>>();
    for (const [type, ids] of idsByType) {
      const table = TABLES[type];
      if (!table) continue;
      const { data: rows } = await supabase.from(table).select("*").in("id", ids);
      for (const row of (rows ?? []) as Record<string, unknown>[]) {
        rowsByKey.set(`${type}:${row.id}`, { ...row, report_type: type });
      }
    }

    const payloadRows = items
      .map((item) => rowsByKey.get(`${item.report_type}:${item.report_id}`))
      .filter((r): r is Record<string, unknown> => r != null);

    let webhookOk = false;
    let webhookError = "";
    try {
      const res = await fetch(cfg.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.webhook_secret, rows: payloadRows }),
      });
      webhookOk = res.ok;
      if (!res.ok) webhookError = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
    } catch (err) {
      webhookError = err instanceof Error ? err.message : String(err);
    }

    const now = new Date().toISOString();
    const ids = items.map((i) => i.id);

    if (webhookOk) {
      await supabase.from("sheet_sync_queue").update({ status: "sent", sent_at: now }).in("id", ids);
    } else {
      await Promise.all(
        items.map((item) =>
          supabase
            .from("sheet_sync_queue")
            .update({ status: "failed", attempts: item.attempts + 1, last_error: webhookError.slice(0, 500) })
            .eq("id", item.id),
        ),
      );
    }

    return jsonResponse({ ok: webhookOk, sent: webhookOk ? items.length : 0, error: webhookOk ? undefined : webhookError });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
