#!/usr/bin/env node
// READ-ONLY inventory of a Storage bucket (default `incident-photos`; pass --bucket=completed-forms), its policies and the tables that could reference it, on the approved staging
// project. Prints bucket facts, normalised prefixes and counts only -- never an object name, owner id or record content.
// Guards: approved staging ref only (environmentGates rejects the production ref), verified TLS, and the whole session is a READ ONLY
// transaction that is rolled back.
//   node --env-file=.env.local scripts/staging/inspect-incident-photos.mjs
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";

environmentGates();
// bucket to inventory (default incident-photos); only a known private-bucket name is accepted
const BUCKET = (process.argv.find((a) => a.startsWith("--bucket=")) ?? "--bucket=incident-photos").split("=")[1];
if (!/^[a-z0-9-]{3,63}$/.test(BUCKET)) throw new Error("invalid bucket name");
const { client } = await connectVerified();
try {
  await client.query("begin read only");
  console.log(`=== ${BUCKET} bucket inventory (staging, read-only, counts only) ===`);
  const b = (await client.query("select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [BUCKET])).rows[0];
  console.log(`bucket present=${Boolean(b)} public=${b?.public} file_size_limit=${b?.file_size_limit ?? "none"} allowed_mime_types=${JSON.stringify(b?.allowed_mime_types ?? null)}`);
  const norm = `regexp_replace(regexp_replace(regexp_replace(name,
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g'),
      '[0-9]{10,}-[0-9a-f]{6,8}', '<ts>-<id>', 'g'),
      '\.[A-Za-z0-9]+$', '.<ext>')`;
  const rows = (await client.query(`select ${norm} as shape, count(*)::int n, count(*) filter (where owner is null)::int owner_null from storage.objects where bucket_id = $1 group by 1 order by 2 desc`, [BUCKET])).rows;
  let total = 0;
  for (const r of rows) { total += r.n; console.log(`  ${String(r.shape).padEnd(48)} objects=${r.n} owner_null=${r.owner_null}`); }
  console.log(`  TOTAL objects=${total}`);
  console.log("--- policies on storage.objects that mention the inventoried bucket (names/commands only) ---");
  const pol = (await client.query(`select policyname, cmd, permissive, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual ilike '%' || $1 || '%' or with_check ilike '%' || $1 || '%') order by cmd, policyname`, [BUCKET])).rows;
  for (const p of pol) console.log(`  [${p.cmd}] ${p.permissive} ${p.policyname} roles=${p.roles}`);
  console.log(`  total=${pol.length}`);
  console.log("--- every permissive INSERT/SELECT policy on storage.objects (names only) to spot unscoped hosted-only policies ---");
  const all = (await client.query(`select policyname, cmd, permissive, roles::text, (qual is null and with_check is null) unconditional from pg_policies where schemaname = 'storage' and tablename = 'objects' order by cmd, policyname`)).rows;
  for (const p of all) console.log(`  [${p.cmd}] ${p.permissive} ${p.policyname} roles=${p.roles}${p.unconditional ? " UNCONDITIONAL" : ""}`);
  console.log("--- tables that could reference the bucket (existence and counts only) ---");
  for (const t of ["incident_photos", "incidents", "caterlink_incidents", "caterlink_incident_photos"]) {
    const ex = (await client.query("select to_regclass($1) r", [`public.${t}`])).rows[0].r;
    if (!ex) { console.log(`  ${t.padEnd(30)} absent`); continue; }
    const cols = (await client.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [t])).rows.map((r) => r.column_name);
    const n = (await client.query(`select count(*)::int n from public.${t}`)).rows[0].n;
    console.log(`  ${t.padEnd(30)} present rows=${n} photo-like columns=${cols.filter((c) => /photo|attach|url|path/i.test(c)).join(",") || "-"}`);
  }
  console.log("--- other buckets: public flag and object counts ---");
  for (const r of (await client.query("select b.id, b.public, (select count(*)::int from storage.objects o where o.bucket_id = b.id) n from storage.buckets b order by 1")).rows) console.log(`  ${r.id.padEnd(28)} public=${r.public} objects=${r.n}`);
  await client.query("rollback");
  console.log("=== done (read-only transaction rolled back) ===");
} finally {
  await client.end();
}
