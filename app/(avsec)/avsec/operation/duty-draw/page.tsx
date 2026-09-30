import { requireProfile } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";
import { getDutyDraw, listDutyDrawHistory, listStationStaffForDraw, listDutyZonesForStation } from "@/lib/phase8/duty-draw";
import { DutyDrawManager } from "@/components/avsec/operation/DutyDrawManager";
import { todayISODateMY } from "@/lib/avsec/datetime";

export default async function DutyDrawPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ station?: string; date?: string }>;
}) {
  const profile = await requireProfile();
  const supabase = await createClient();
  const { data: isOperationManager } = await supabase.rpc("has_active_role", { p_role_code: "operation_manager" });

  const searchParams = await searchParamsPromise;
  const station = searchParams.station || profile.station || "";
  const drawDate = searchParams.date || todayISODateMY();

  if (!station) {
    return (
      <main className="min-h-screen pb-32">
        <div className="max-w-2xl mx-auto px-4 py-6">
          <div className="card p-6 text-center text-xs text-muted-foreground">
            No station on file for your account — an Operation Manager can pass a station via
            ?station=.
          </div>
        </div>
      </main>
    );
  }

  const [drawResult, historyResult, staffResult, zonesResult] = await Promise.all([
    getDutyDraw(station, drawDate),
    listDutyDrawHistory(station),
    isOperationManager ? listStationStaffForDraw(station) : Promise.resolve({ ok: true, error: null, data: [] }),
    listDutyZonesForStation(station),
  ]);

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-xl font-bold font-display">Duty-Zone Draw</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {station} · {drawDate}. {isOperationManager
              ? "Owned by Operation Manager. A finalized draw is immutable in this release — reset is not available unless separately authorized."
              : "Read-only: only a finalized (published) result is visible to station staff."}
          </p>
        </div>

        <DutyDrawManager
          station={station}
          drawDate={drawDate}
          isOperationManager={!!isOperationManager}
          initialRows={drawResult.data ?? []}
          initialHistory={historyResult.data ?? []}
          staff={(staffResult.data ?? []) as { profile_id: string; name: string; staff_no: string | null }[]}
          zones={zonesResult.data ?? []}
          fetchError={drawResult.error ?? historyResult.error}
        />
      </div>
    </main>
  );
}
