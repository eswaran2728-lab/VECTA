#!/usr/bin/env node
// READ-ONLY inventory of the `signatures` Storage bucket and its policies on the approved staging project.
// Prints normalized path prefixes and counts only -- never an object name, owner id or any record content.
// Guards: approved staging ref only (production ref refused by environmentGates), verified TLS, and the whole session is a
// READ ONLY transaction that is rolled back; no statement here can change data.
//   node --env-file=.env.local scripts/staging/inspect-signature-bucket.mjs
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";

environmentGates();
const { client } = await connectVerified();
try {
  await client.query("begin read only");
  console.log("=== signatures bucket inventory (staging, read-only, counts only) ===");
  const bucket = (await client.query("select id, public from storage.buckets where id = 'signatures'")).rows[0];
  console.log(`bucket present=${Boolean(bucket)} public=${bucket?.public}`);

  // normalised prefix: first path segment, with uuid / timestamp-like segments replaced by placeholders
  const norm = `regexp_replace(regexp_replace(regexp_replace(name,
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', 'g'),
      '[0-9]{10,}-[0-9a-f]{6,8}', '<ts>-<id>', 'g'),
      '\\.[A-Za-z0-9]+$', '.<ext>')`;
  const rows = (await client.query(
    `select ${norm} as shape, count(*)::int n, count(*) filter (where owner is null)::int owner_null,
            count(*) filter (where exists (select 1 from public.caterlink_checkpoint_part_a c where c.signature_url = o.name)
                              or exists (select 1 from public.part_b_c c where c.signature_url = o.name)
                              or exists (select 1 from public.caterlink_checkpoint_part_d c where c.signature_url = o.name)
                              or exists (select 1 from public.caterlink_checkpoint_hub c where c.signature_url = o.name)
                              or exists (select 1 from public.caterlink_checkpoint_redq c where c.signature_url = o.name)
                              or exists (select 1 from public.caterlink_vendor_checkpoints c where c.signature_url = o.name))::int referenced
       from storage.objects o where bucket_id = 'signatures' group by 1 order by 2 desc`)).rows;
  let total = 0;
  for (const r of rows) {
    total += r.n;
    console.log(`  ${String(r.shape).padEnd(48)} objects=${r.n} owner_null=${r.owner_null} referenced=${r.referenced}`);
  }
  console.log(`  TOTAL objects=${total}`);

  console.log("--- policies on storage.objects that mention the signatures bucket (names/commands only) ---");
  const pol = (await client.query(
    `select policyname, cmd, permissive, roles::text from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and (qual ilike '%signatures%' or with_check ilike '%signatures%')
      order by cmd, policyname`)).rows;
  for (const p of pol) console.log(`  [${p.cmd}] ${p.permissive} ${p.policyname} roles=${p.roles}`);
  console.log(`  total=${pol.length}`);

  console.log("--- reference tables: rows with a signature_url, by checkpoint table (counts only) ---");
  for (const t of ["caterlink_checkpoint_part_a", "part_b_c", "caterlink_checkpoint_part_d", "caterlink_checkpoint_hub", "caterlink_checkpoint_redq", "caterlink_vendor_checkpoints"]) {
    const n = (await client.query(`select count(*)::int n, count(*) filter (where signature_url is not null)::int s from public.${t}`)).rows[0];
    console.log(`  ${t.padEnd(34)} rows=${n.n} with_signature=${n.s}`);
  }
  await client.query("rollback");
  console.log("=== done (read-only transaction rolled back) ===");
} finally {
  await client.end();
}
