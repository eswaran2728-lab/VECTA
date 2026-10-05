#!/usr/bin/env node
// Read-only: which schemas/tables the staging Data API (PostgREST) exposes to the anon key.
// Prints names, counts and HTTP statuses only -- never keys or row data.
const REF = "ddlctzbnqewubltcavkh";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("Supabase URL / publishable key not configured");
if (!new URL(url).hostname.startsWith(REF)) throw new Error("URL is not the approved staging project");
const h = { apikey: key, Authorization: `Bearer ${key}` };
const root = await fetch(`${url}/rest/v1/`, { headers: h });
const out = { rootStatus: root.status };
if (root.ok) {
  const spec = await root.json();
  const paths = Object.keys(spec.paths ?? {});
  out.exposedPathCount = paths.length;
  out.exposedTables = paths.filter((p) => !p.startsWith("/rpc/") && p !== "/").map((p) => p.slice(1)).sort();
  out.exposedRpcCount = paths.filter((p) => p.startsWith("/rpc/")).length;
}
out.anonReads = {};
for (const t of ["profiles", "stations", "drivers", "report_sec014", "team_rosters", "org_teams"]) {
  const r = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: h });
  let n = null;
  try { const b = await r.json(); n = Array.isArray(b) ? b.length : "non-array"; } catch { /* none */ }
  out.anonReads[t] = { status: r.status, rows: n };
}
const sch = await fetch(`${url}/rest/v1/stations?select=code&limit=1`, { headers: { ...h, "Accept-Profile": "auth" } });
out.authSchemaProbeStatus = sch.status;
console.log(JSON.stringify(out, null, 1));
