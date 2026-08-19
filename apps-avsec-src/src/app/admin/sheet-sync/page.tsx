import { requireRole, ADMIN_ROLES } from "@/lib/auth";
import { getSheetSyncConfig, getSheetSyncCounts, getRecentFailedSyncs } from "@/lib/admin/sheetSyncQueries";
import { updateSheetSyncConfig, retryFailedSyncs, triggerSheetSyncNow } from "@/lib/admin/sheetSyncActions";
import { AppHeader } from "@/components/layout/AppHeader";
import { formatDateTimeMY } from "@/lib/datetime";

export default async function AdminSheetSyncPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const profile = await requireRole(ADMIN_ROLES);
  const [config, counts, failed] = await Promise.all([
    getSheetSyncConfig(),
    getSheetSyncCounts(),
    getRecentFailedSyncs(),
  ]);

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Google Sheets Sync" backHref="/admin/users" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="t-display text-xl">Google Sheets Sync</h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--soft)" }}>
            One-way, read-only mirror of every submitted report into a Google Sheet — Sheets
            is never a source of truth, only a copy. See{" "}
            <span className="t-mono">docs/GOOGLE_SHEETS_SETUP.md</span> for the Apps Script
            setup steps.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        <div className="grid grid-cols-3 gap-2">
          <div className="card p-4 text-center">
            <p className="text-2xl font-bold" style={{ color: "var(--soft)" }}>{counts.pending}</p>
            <p className="t-mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>PENDING</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-2xl font-bold" style={{ color: "var(--green)" }}>{counts.sent}</p>
            <p className="t-mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>SENT</p>
          </div>
          <div className="card p-4 text-center">
            <p className="text-2xl font-bold" style={{ color: "var(--red)" }}>{counts.failed}</p>
            <p className="t-mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>FAILED</p>
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
                className="input-base t-mono"
              />
            </div>
            <div>
              <label className="field-label">Shared Secret</label>
              <input
                type="text"
                name="webhookSecret"
                defaultValue={config?.webhook_secret ?? ""}
                placeholder="A long random string — also pasted into the Apps Script"
                className="input-base t-mono"
              />
              <p className="field-hint">
                Must exactly match the <span className="t-mono">SYNC_SECRET</span> constant in
                the deployed Apps Script.
              </p>
            </div>
            <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--ink2)" }}>
              <input type="checkbox" name="enabled" defaultChecked={config?.enabled ?? false} />
              Sync enabled (runs automatically every 2 minutes when on)
            </label>
            <button type="submit" className="btn-primary w-full">
              Save configuration
            </button>
          </form>
        </div>

        {failed.length > 0 && (
          <div className="card p-4 space-y-2">
            <p className="section-title">Recent failures</p>
            <div className="divide-y" style={{ borderColor: "var(--line2)" }}>
              {failed.map((f) => (
                <div key={f.id} className="py-2.5">
                  <p className="t-mono text-[10.5px] font-semibold" style={{ color: "var(--ink2)" }}>
                    {f.report_type.toUpperCase()} · {f.report_no ?? f.report_id.slice(0, 8)}
                  </p>
                  <p className="t-mono text-[9.5px] mt-1" style={{ color: "var(--red)" }}>
                    {f.attempts} attempt(s) · {f.last_error ?? "Unknown error"}
                  </p>
                  <p className="t-mono text-[9px] mt-1" style={{ color: "var(--faint)" }}>
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
