#!/usr/bin/env node
// Phase "dashboard/role-workspaces-adjustment": encrypted backup restore & inspection.
// Decrypts and verifies the integrity of an AES-256-GCM backup envelope.
//
// Usage:
//   node scripts/staging/restore-backup.mjs --file=<backup.enc.json> [--extract-to=<dir>]
//   (Passphrase can be provided via VECTA_BACKUP_PASSPHRASE env var or --passphrase=<secret>)

import fs from "node:fs";
import path from "node:path";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";

const args = process.argv.slice(2);
const filePathArg = args.find((a) => a.startsWith("--file="))?.split("=")[1] || args.find((a) => !a.startsWith("--"));
const extractToArg = args.find((a) => a.startsWith("--extract-to="))?.split("=")[1];
const passphrase = process.env.VECTA_BACKUP_PASSPHRASE || args.find((a) => a.startsWith("--passphrase="))?.split("=")[1];

async function main() {
  console.log("=== VECTA encrypted backup decryption & inspection ===");

  if (!filePathArg) {
    console.error("ERROR: Backup file path must be specified via --file=<path>");
    process.exit(1);
  }

  if (!fs.existsSync(filePathArg)) {
    console.error(`ERROR: File does not exist at ${filePathArg}`);
    process.exit(1);
  }

  if (!passphrase) {
    console.error("ERROR: Passphrase must be provided via VECTA_BACKUP_PASSPHRASE environment variable or --passphrase=<secret>");
    process.exit(1);
  }

  console.log(`Reading encrypted backup from: ${filePathArg}`);
  const rawEnvelope = fs.readFileSync(filePathArg, "utf8");

  console.log("Decrypting and verifying AES-256-GCM authentication tag...");
  const payload = decryptBackupPayload(rawEnvelope, passphrase);
  console.log("Verification SUCCESSFUL: Backup is authentic, intact, and decrypted.");

  console.log("\n--- Backup Summary ---");
  console.log(`  Project Ref:  ${payload.projectRef ?? "unknown"}`);
  console.log(`  Exported At:  ${payload.exportedAt ?? "unknown"}`);
  console.log(`  Auth Users:   ${payload.authUsers?.length ?? 0} user(s)`);

  const tables = Object.keys(payload.data ?? {});
  console.log(`  Tables (${tables.length}):`);
  for (const table of tables) {
    const rows = payload.data[table];
    console.log(`    ${table.padEnd(30)} ${rows?.length ?? 0} row(s)`);
  }

  const storageItems = payload.storage ?? [];
  console.log(`  Storage:      ${storageItems.length} object(s)`);

  if (extractToArg) {
    console.log(`\nExtracting decrypted contents to: ${extractToArg}`);
    fs.mkdirSync(extractToArg, { recursive: true, mode: 0o700 });

    const dataDir = path.join(extractToArg, "data");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const table of tables) {
      fs.writeFileSync(path.join(dataDir, `${table}.json`), JSON.stringify(payload.data[table], null, 2), { mode: 0o600 });
    }

    if (payload.authUsers) {
      fs.writeFileSync(path.join(extractToArg, "auth-users-inventory.json"), JSON.stringify(payload.authUsers, null, 2), { mode: 0o600 });
    }

    if (payload.storage) {
      const storageDir = path.join(extractToArg, "storage");
      fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(extractToArg, "storage-inventory.json"), JSON.stringify(payload.storage.map((s) => ({ bucket: s.bucket, object: s.object, size: s.size })), null, 2), { mode: 0o600 });
      for (const item of payload.storage) {
        if (item.base64Bytes) {
          const bucketDir = path.join(storageDir, item.bucket);
          fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(bucketDir, item.object.replace(/\//g, "__")), Buffer.from(item.base64Bytes, "base64"), { mode: 0o600 });
        }
      }
    }
    console.log("Decrypted extraction complete.");
  } else {
    console.log("\nInspection complete (in-memory verification only). Pass --extract-to=<dir> to write plaintext to disk.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
