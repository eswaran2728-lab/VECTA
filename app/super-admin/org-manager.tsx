import { Building2, Info, Shield } from "lucide-react";
import type { AocNode } from "@/lib/super-admin/hierarchy";

/**
 * Super Admin organizational hierarchy: a read-only view of the canonical AOC -> operating entity / department / hub structure.
 * Creating or changing an AOC or operating entity is not activated -- it needs an owner decision about scopes first -- so there is no form here.
 */
export function OrgManager({ hierarchy }: { hierarchy: AocNode[]; userName?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="vecta-panel flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Shield className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-display text-xl font-bold tracking-[0.03em] text-foreground">Platform Super Admin</h1>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">AOC and operating entity structure (read-only)</p>
          </div>
        </div>
      </div>

      <div className="vecta-panel flex items-start gap-3 px-6 py-4" role="note">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">
          Creating or changing an AOC or operating entity is not activated. Role scopes, entity Admin checks, hubs and stations are bound to the existing
          structure below, so a new AOC or entity needs an owner decision on its scopes first.
        </p>
      </div>

      <div className="vecta-panel px-6 py-5">
        <div className="mb-4 flex items-center justify-between border-b border-border/60 pb-3">
          <p className="vecta-eyebrow">AOCs ({hierarchy.length})</p>
        </div>
        {hierarchy.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No AOC is configured or the structure is not available right now.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {hierarchy.map((aoc) => (
              <section key={aoc.code} className="py-4 first:pt-2 last:pb-2" aria-label={`${aoc.name} structure`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <h2 className="text-sm font-bold text-foreground">{aoc.name}</h2>
                  <span className="vecta-chip font-mono text-[10px]">{aoc.code}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{aoc.isActive ? "active" : "inactive"}</span>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="vecta-eyebrow">Operating entities</dt>
                    <dd className="mt-1 space-y-0.5 text-xs text-foreground">
                      {aoc.entities.length === 0 ? "None" : aoc.entities.map((e) => <div key={e.code}>{e.code} — {e.name} ({e.flightPrefix})</div>)}
                    </dd>
                  </div>
                  <div>
                    <dt className="vecta-eyebrow">Departments</dt>
                    <dd className="mt-1 space-y-0.5 text-xs text-foreground">
                      {aoc.departments.length === 0 ? "None" : aoc.departments.map((d) => <div key={d.code}>{d.name}</div>)}
                    </dd>
                  </div>
                  <div>
                    <dt className="vecta-eyebrow">Hubs</dt>
                    <dd className="mt-1 space-y-0.5 text-xs text-foreground">
                      {aoc.hubs.length === 0 ? "None" : aoc.hubs.map((h) => <div key={h.code}>{h.code} — {h.name} ({h.stationCount} stations)</div>)}
                    </dd>
                  </div>
                </dl>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
