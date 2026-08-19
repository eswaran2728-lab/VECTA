import Link from "next/link";
import { requireRole, ADMIN_ROLES } from "@/lib/avsec/auth";
import { STATIONS } from "@/lib/avsec/reference-data";
import { getZonesForStation, getZoneById } from "@/lib/avsec/duty/zone-queries";
import { upsertZone, toggleZoneActive } from "@/lib/avsec/duty/zone-actions";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import ZoneEditorLoader from "@/components/avsec/duty/ZoneEditorLoader";

export default async function AdminZonesPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ station?: string; edit?: string; error?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(ADMIN_ROLES);
  const station = searchParams.station || profile.station || STATIONS[0];

  const [zones, editing] = await Promise.all([
    getZonesForStation(station),
    searchParams.edit ? getZoneById(searchParams.edit) : Promise.resolve(null),
  ]);

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Duty Zones" backHref="/avsec/admin/users" />
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        <div>
          <h1 className="t-display text-xl">Duty Zones</h1>
          <p className="text-[13px] mt-1" style={{ color: "var(--soft)" }}>
            Geofence areas the check-in screen tests against. Draw a zone by tapping points
            on the map — the app connects them into a polygon automatically.
          </p>
        </div>

        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        <form method="get" className="card p-4 flex items-end gap-3">
          <div>
            <label className="field-label">Station</label>
            <select name="station" defaultValue={station} className="input-base">
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-secondary">
            Switch
          </button>
        </form>

        <div className="card p-4 space-y-2">
          <p className="section-title">Zones at {station}</p>
          {zones.length === 0 && (
            <p className="text-sm" style={{ color: "var(--soft)" }}>
              No zones defined yet for this station.
            </p>
          )}
          <div className="divide-y" style={{ borderColor: "var(--line2)" }}>
            {zones.map((z) => (
              <div key={z.id} className="flex items-center justify-between py-2.5 gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                    {z.code} · {z.name}
                  </p>
                  <p className="t-mono text-[10px]" style={{ color: "var(--soft)" }}>
                    radius ≈{z.radius_m}m
                    {!(z as { active?: boolean }).active ? " · INACTIVE" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Link href={`/avsec/admin/zones?station=${encodeURIComponent(station)}&edit=${z.id}`} className="btn-quiet">
                    Edit
                  </Link>
                  <form action={toggleZoneActive}>
                    <input type="hidden" name="id" value={z.id} />
                    <input type="hidden" name="station" value={station} />
                    <input type="hidden" name="active" value={String((z as { active?: boolean }).active ?? true)} />
                    <button type="submit" className="btn-quiet">
                      {(z as { active?: boolean }).active ? "Deactivate" : "Reactivate"}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4 space-y-3">
          <p className="section-title">{editing ? `Edit ${editing.code}` : "Add a new zone"}</p>
          <form action={upsertZone} className="space-y-3">
            {editing && <input type="hidden" name="id" value={editing.id} />}
            <input type="hidden" name="station" value={station} />
            <input type="hidden" name="geometry_json" id="zone-geometry" defaultValue="" />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Code</label>
                <input
                  type="text"
                  name="code"
                  defaultValue={editing?.code ?? ""}
                  placeholder="e.g. TGATE"
                  required
                  className="input-base"
                />
              </div>
              <div>
                <label className="field-label">Name</label>
                <input
                  type="text"
                  name="name"
                  defaultValue={editing?.name ?? ""}
                  placeholder="e.g. Terminal Gate"
                  required
                  className="input-base"
                />
              </div>
            </div>

            <ZoneEditorLoader initialPolygon={editing?.polygon ?? null} hiddenInputId="zone-geometry" />

            <button type="submit" className="btn-primary w-full">
              {editing ? "Save changes" : "Create zone"}
            </button>
            {editing && (
              <Link href={`/avsec/admin/zones?station=${encodeURIComponent(station)}`} className="btn-quiet w-full block text-center">
                Cancel edit
              </Link>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
