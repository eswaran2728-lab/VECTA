import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { listPendingReceipts } from "@/lib/avsec/caterlink/receipt";
import { ReceiptForm } from "@/components/avsec/caterlink/ReceiptForm";
import { createClient } from "@/lib/supabase/server";

/**
 * CaterLink final receipt (BKI and KCH). Receipt only: there is no scanner, no live stream and no repeat of the earlier checkpoints here.
 * Access is decided by the station capability table (can_user_confirm_caterlink_receipt); a station without the capability (BTU,
 * for example) is sent back to its dashboard, and the RPCs refuse the same callers.
 */
export default async function CaterlinkReceiptPage() {
  const profile = await requireProfile();
  const station = (profile.canonical as CanonicalAccess).stationCode;
  if (!station) redirect("/avsec/my-dashboard");
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("can_user_confirm_caterlink_receipt", { p_station_code: station });
  if (allowed !== true) redirect("/avsec/my-dashboard");

  const pending = await listPendingReceipts(station);

  return (
    <main className="min-h-screen pb-28">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">Final receipt — {station}</h1>
          <p className="font-mono text-xs text-muted-foreground">
            Confirm what arrived: route, seal and delivery details. You are recorded as the receiver, with this station and the time.
          </p>
        </header>
        {!pending.ok && (
          <p className="font-mono text-xs text-destructive" role="alert">
            {pending.error}
          </p>
        )}
        {pending.ok && pending.rows.length === 0 && (
          <p className="card p-6 text-center font-mono text-xs text-muted-foreground" role="status">
            No movements are waiting for final receipt at {station}.
          </p>
        )}
        {pending.rows.map((r) => (
          <ReceiptForm key={r.id} row={r} station={station} />
        ))}
      </div>
    </main>
  );
}
