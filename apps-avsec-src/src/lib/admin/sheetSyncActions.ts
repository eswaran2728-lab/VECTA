"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, ADMIN_ROLES } from "@/lib/auth";

export async function updateSheetSyncConfig(formData: FormData) {
  await requireRole(ADMIN_ROLES);

  const webhookUrl = String(formData.get("webhookUrl") || "").trim();
  const webhookSecret = String(formData.get("webhookSecret") || "").trim();
  const enabled = formData.get("enabled") === "on";

  const supabase = createClient();
  const { error } = await supabase
    .from("sheet_sync_config")
    .update({
      webhook_url: webhookUrl || null,
      webhook_secret: webhookSecret || null,
      enabled,
      updated_at: new Date().toISOString(),
    })
    .eq("id", true);

  revalidatePath("/admin/sheet-sync");
  if (error) redirect(`/admin/sheet-sync?error=${encodeURIComponent(error.message)}`);
}

export async function retryFailedSyncs() {
  await requireRole(ADMIN_ROLES);

  const supabase = createClient();
  await supabase
    .from("sheet_sync_queue")
    .update({ status: "pending", last_error: null })
    .eq("status", "failed");

  revalidatePath("/admin/sheet-sync");
}

export async function triggerSheetSyncNow() {
  await requireRole(ADMIN_ROLES);

  const supabase = createClient();
  const { data: cfg } = await supabase
    .from("sheet_sync_config")
    .select("webhook_secret")
    .eq("id", true)
    .maybeSingle();

  const baseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!baseUrl || !cfg?.webhook_secret) {
    redirect("/admin/sheet-sync?error=" + encodeURIComponent("Set and save a webhook secret first."));
  }

  // redirect() throws internally — kept outside the try/catch below so that throw isn't
  // mistaken for a fetch failure and re-wrapped into a second, garbled redirect.
  let errorMessage: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/functions/v1/sheets-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": cfg.webhook_secret },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      errorMessage = `Sync request failed (${res.status}): ${text.slice(0, 200)}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Sync failed";
  }

  if (errorMessage) {
    redirect("/admin/sheet-sync?error=" + encodeURIComponent(errorMessage));
  }

  revalidatePath("/admin/sheet-sync");
}
