/**
 * Backfills part_a/b/c/d.signature_hash for records created before Phase 6
 * by downloading each signature PNG and computing its SHA-256.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (in env or .env.local):
 *   node scripts/backfill-signature-hashes.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || serviceKey.includes("placeholder")) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required for backfill.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

for (const table of ["part_a", "part_b", "part_c", "part_d"]) {
  const { data: rows, error } = await admin
    .from(table)
    .select("id, signature_url")
    .is("signature_hash", null);
  if (error) throw error;

  for (const row of rows ?? []) {
    const { data: blob, error: dlError } = await admin.storage
      .from("signatures")
      .download(row.signature_url);
    if (dlError) {
      console.warn(`${table} ${row.id}: download failed (${dlError.message})`);
      continue;
    }
    const hash = createHash("sha256")
      .update(Buffer.from(await blob.arrayBuffer()))
      .digest("hex");
    // Immutability triggers block updates; write via SQL bypass is not
    // available here, so temporarily relax with a dedicated RPC if needed.
    const { error: upError } = await admin
      .from(table)
      .update({ signature_hash: hash })
      .eq("id", row.id);
    if (upError) {
      console.warn(`${table} ${row.id}: ${upError.message}`);
    } else {
      console.log(`${table} ${row.id}: hashed`);
    }
  }
}
console.log("Backfill complete.");
