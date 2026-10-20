import Link from "next/link";
import { getBayBoard, getBayBoardScopes } from "@/lib/dashboard/entity-leadership";

/**
 * Read-only Bay Board for MAA/AAX Boss and Admin: a Hub + Station selector over the Malaysia AOC's hubs and stations. It does NOT
 * infer an operating entity from a station (any entity may operate at any station), and it is separate from report authorization --
 * seeing an aircraft here grants no report access. The rows come from get_bay_board_secure(), which re-checks the caller.
 */
export async function EntityBayBoard({ hubCode, stationCode }: { hubCode: string | null; stationCode: string | null }) {
  const scopes = await getBayBoardScopes();

  if (scopes.status !== "ok") {
    return (
      <p className="font-mono text-xs text-destructive" role="alert">
        {scopes.status === "unauthorized" ? "Not authorized for this scope." : "The Bay Board scopes could not be loaded right now."}
      </p>
    );
  }

  const hubs = [...new Map(scopes.scopes.map((s) => [s.hubCode, s.hubName])).entries()];
  const hub = hubCode && hubs.some(([code]) => code === hubCode) ? hubCode : null;
  const stations = scopes.scopes.filter((s) => !hub || s.hubCode === hub);
  const station = stationCode && stations.some((s) => s.stationCode === stationCode) ? stationCode : null;
  const board = await getBayBoard(hub, station);

  return (
    <div className="space-y-4">
      <form method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Bay Board scope">
        <label className="space-y-1 text-xs">
          <span className="font-mono text-muted-foreground">Hub</span>
          <select name="hub" defaultValue={hub ?? ""} className="input-base min-w-[10rem]">
            <option value="">All hubs</option>
            {hubs.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="font-mono text-muted-foreground">Station</span>
          <select name="station" defaultValue={station ?? ""} className="input-base min-w-[10rem]">
            <option value="">All stations{hub ? " in hub" : ""}</option>
            {stations.map((s) => (
              <option key={s.stationCode} value={s.stationCode}>
                {s.stationCode} — {s.stationName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">
          Show
        </button>
        <Link href="/avsec/bay-board" className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
          Reset
        </Link>
      </form>

      {board.status === "error" && (
        <p className="font-mono text-xs text-destructive" role="alert">
          The Bay Board could not be loaded right now. Try again shortly.
        </p>
      )}
      {board.status === "unauthorized" && <p className="font-mono text-xs italic text-muted-foreground">Not authorized for this scope.</p>}
      {board.status === "ok" && board.rows.length === 0 && (
        <p className="card p-6 text-center font-mono text-xs text-muted-foreground" role="status">
          No aircraft are currently logged on the ground for {station ?? hub ?? "the selected scope"}.
        </p>
      )}
      {board.status === "ok" && board.rows.length > 0 && (
        <div className="card overflow-x-auto p-4">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">Station</th>
                <th className="py-2 pr-3">Registration</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Bay</th>
                <th className="py-2 pr-3">Flight</th>
                <th className="py-2 pr-3">On ground since</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="py-2 pr-3 font-mono">{r.station}</td>
                  <td className="py-2 pr-3 font-mono">{r.regNo ?? "—"}</td>
                  <td className="py-2 pr-3">{r.aircraftType ?? "—"}</td>
                  <td className="py-2 pr-3">{r.bay ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono">{r.flight ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono">{r.onGroundSince ? new Date(r.onGroundSince).toLocaleString("en-MY") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
