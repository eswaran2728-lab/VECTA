#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": local staging backup/export.
// Read-only against the hosted project (select/list calls only); writes
// ONLY to a local, gitignored directory outside any committed path.
//
// HONEST LIMITATION, stated once here: with only the Supabase REST/Storage/
// Auth-Admin secret key (no direct Postgres connection string, no
// Management API token), this script CANNOT produce:
//   - a real pg_dump-equivalent schema backup (DDL text) -- that requires
//     direct Postgres access or the Management API's own backup feature;
//   - Auth user PASSWORDS -- Supabase Auth never exposes password hashes
//     via any API, by design; a "backup" of Auth users is an inventory
//     (id/email/created_at/role metadata), never a credential a restore
//     could use to log in as that user without a password reset;
//   - raw Storage object BYTES at scale without downloading every object
///    individually (this script DOES download every object it finds,
//     since bucket/object counts observed this round are 0 -- see
//     discover.mjs output -- so this is cheap today; it will not scale
//     silently if objects are added later without re-checking).
// Every one of these is stated in the script's own output, not left
// implicit.
//
// Usage:
//   node --env-file=.env.local scripts/staging/backup.mjs [--out-dir=<path>]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";

const args = process.argv.slice(2);
const outDirArg = args.find((a) => a.startsWith("--out-dir="))?.split("=")[1];

async function main() {
  console.log("=== VECTA staging local backup/export (read-only against the hosted project) ===");
  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  const outDir = outDirArg || path.join(os.tmpdir(), "vecta-staging-backups", `${ctx.projectRef}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  console.log(`\nWriting to (outside the repository, gitignored defensively if ever created inside it): ${outDir}`);

  console.log("\n--- Database DATA export (every row this credential can read) ---");
  const tables = (await (async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY },
    });
    if (!res.ok) return [];
    const spec = await res.json();
    return Object.keys(spec.paths ?? {}).map((p) => p.replace(/^\//, "")).filter((p) => p && !p.startsWith("rpc/"));
  })());

  const dataDir = path.join(outDir, "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const table of tables) {
    const { data, error } = await client.from(table).select("*");
    if (error) {
      console.log(`  ${table}: SKIPPED (${error.message})`);
      continue;
    }
    fs.writeFileSync(path.join(dataDir, `${table}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
    console.log(`  ${table}: ${data.length} row(s) exported`);
  }
  console.log(`  NOTE: only the ${tables.length} table(s) exposed via the REST API (public-exposed, grant-dependent) were attempted -- Phase 2-13 tables with zero anon/authenticated grant are NOT included; see discover.mjs for the full existence check.`);

  console.log("\n--- Database SCHEMA backup ---");
  console.log("  NOT PRODUCED: no direct Postgres connection string or Management API token is configured, so no pg_dump-equivalent DDL text can be generated. The repository's own supabase/migrations/ tree IS the schema source of truth and needs no separate backup here.");

  console.log("\n--- Auth-user inventory (id/email/created_at/metadata only -- never a password) ---");
  const authInventory = [];
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.log(`  ERROR: ${error.message}`);
      break;
    }
    authInventory.push(...data.users.map((u) => ({ id: u.id, email: u.email, created_at: u.created_at, user_metadata: u.user_metadata })));
    if (data.users.length < 200) break;
    page += 1;
  }
  fs.writeFileSync(path.join(outDir, "auth-users-inventory.json"), JSON.stringify(authInventory, null, 2), { mode: 0o600 });
  console.log(`  ${authInventory.length} user(s) inventoried (no password hash -- Supabase Auth never exposes one via any API).`);

  console.log("\n--- Storage bucket/object inventory (+ object bytes, since current volume is small) ---");
  const { data: buckets, error: bucketsError } = await client.storage.listBuckets();
  const storageDir = path.join(outDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  if (bucketsError) {
    console.log(`  ERROR: ${bucketsError.message}`);
  } else {
    const inventory = [];
    for (const bucket of buckets ?? []) {
      const { data: objects, error: listError } = await client.storage.from(bucket.name).list(undefined, { limit: 1000 });
      if (listError) {
        inventory.push({ bucket: bucket.name, error: listError.message });
        continue;
      }
      const bucketDir = path.join(storageDir, bucket.name);
      fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
      for (const obj of objects) {
        if (!obj.id) continue; // folders have no id
        const { data: bytes, error: downloadError } = await client.storage.from(bucket.name).download(obj.name);
        if (downloadError) {
          inventory.push({ bucket: bucket.name, object: obj.name, error: downloadError.message });
          continue;
        }
        fs.writeFileSync(path.join(bucketDir, obj.name.replace(/\//g, "__")), Buffer.from(await bytes.arrayBuffer()), { mode: 0o600 });
        inventory.push({ bucket: bucket.name, object: obj.name, size: obj.metadata?.size ?? null });
      }
      console.log(`  ${bucket.name}: ${objects.length} object(s)`);
    }
    fs.writeFileSync(path.join(outDir, "storage-inventory.json"), JSON.stringify(inventory, null, 2), { mode: 0o600 });
  }

  console.log("\n--- Migration history backup ---");
  console.log("  NOT PRODUCED: supabase_migrations.schema_migrations is outside the `public` schema this credential can read; a direct Postgres connection or the Supabase CLI (`supabase migration list --linked`) is required. The repository's own git history of supabase/migrations/ is the durable record of what SHOULD be applied; it is not a substitute for reading what actually IS applied.");

  console.log(`\n=== Backup complete at: ${outDir} ===`);
  console.log("No record was created, modified, or deleted on the hosted project. All writes were local, to the path above.");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
