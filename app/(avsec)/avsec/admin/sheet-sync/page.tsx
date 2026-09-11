import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { getSheetSyncConfig, getSheetSyncCounts, getRecentFailedSyncs } from "@/lib/avsec/admin/sheetSyncQueries";
import { updateSheetSyncConfig, retryFailedSyncs, triggerSheetSyncNow } from "@/lib/avsec/admin/sheetSyncActions";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function AdminSheetSyncPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(ADMIN_ROLES);
  const [config, counts, failed] = await Promise.all([
    getSheetSyncConfig(),
    getSheetSyncCounts(),
    getRecentFailedSyncs(),
  ]);

  return (
    <main className="min-h-screen pb-16">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">Google Sheets Sync</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            One-way, read-only mirror of every submitted report into a Google Sheet — Sheets
            is never a source of truth, only a copy. See{" "}
            <span className="font-mono text-primary">docs/GOOGLE_SHEETS_SETUP.md</span> for the Apps Script
            setup steps.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        <div className="grid grid-cols-3 gap-2">
          <div className="card p-4 text-center">
            <p className="font-mono text-2xl font-bold text-muted-foreground">{counts.pending}</p>
            <p className="font-mono text-[9px] uppercase tracking-wider mt-1 text-muted-foreground">PENDING</p>
          </div>
          <div className="card p-4 text-center">
            <p className="font-mono text-2xl font-bold text-success">{counts.sent}</p>
            <p className="font-mono text-[9px] uppercase tracking-wider mt-1 text-muted-foreground">SENT</p>
          </div>
          <div className="card p-4 text-center">
            <p className="font-mono text-2xl font-bold text-destructive">{counts.failed}</p>
            <p className="font-mono text-[9px] uppercase tracking-wider mt-1 text-muted-foreground">FAILED</p>
          </div>
        </div>

        <div className="flex gap-2">
          <form action={triggerSheetSyncNow} className="flex-1">
            <button type="submit" className="btn-secondary w-full">
              Sync Now
            </button>
          </form>
          {counts.failed > 0 && (
            <form action={retryFailedSyncs} className="flex-1">
              <button type="submit" className="btn-secondary w-full">
                Retry Failed ({counts.failed})
              </button>
            </form>
          )}
        </div>

        <div className="card p-4 space-y-3">
          <p className="section-title">Configuration</p>
          <form action={updateSheetSyncConfig} className="space-y-3">
            <div>
              <label className="field-label">Apps Script Web App URL</label>
              <input
                type="url"
                name="webhookUrl"
                defaultValue={config?.webhook_url ?? ""}
                placeholder="https://script.google.com/macros/s/.../exec"
                className="input-base font-mono text-xs"
              />
            </div>
            <div>
              <label className="field-label">Shared Secret</label>
              <input
                type="text"
                name="webhookSecret"
                defaultValue={config?.webhook_secret ?? ""}
                placeholder="A long random string — also pasted into the Apps Script"
                className="input-base font-mono text-xs"
              />
              <p className="field-hint">
                Must exactly match the <span className="font-mono text-foreground">SYNC_SECRET</span> constant in
                the deployed Apps Script.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
              <input type="checkbox" name="enabled" defaultChecked={config?.enabled ?? false} className="rounded border-border" />
              Sync enabled (runs automatically every 2 minutes when on)
            </label>
            <button type="submit" className="btn-primary w-full">
              Save configuration
            </button>
          </form>
        </div>

        {failed.length > 0 && (
          <div className="card p-4 space-y-2">
            <p className="section-title text-destructive">Recent failures</p>
            <div className="divide-y divide-border/60">
              {failed.map((f) => (
                <div key={f.id} className="py-2.5">
                  <p className="font-mono text-xs font-semibold text-foreground">
                    {f.report_type.toUpperCase()} · {f.report_no ?? f.report_id.slice(0, 8)}
                  </p>
                  <p className="font-mono text-[10px] mt-1 text-destructive">
                    {f.attempts} attempt(s) · {f.last_error ?? "Unknown error"}
                  </p>
                  <p className="font-mono text-[9px] mt-1 text-muted-foreground">
                    {formatDateTimeMY(f.created_at)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
