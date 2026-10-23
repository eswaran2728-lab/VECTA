#!/usr/bin/env node
// Guarded, single-migration staging rollout. Dry-run by default; --live requires an exact confirmation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { environmentGates, connectVerified, APPROVED_REF } from "./lib/run-gates.mjs";

const VERSION = "20261120000001";
const NAME = "caterlink_all_final_receipts_pdf";
const CONFIRM = `APPLY ${VERSION} TO STAGING ${APPROVED_REF}`;
const fail = (m) => { throw new Error(m); };
const args = process.argv.slice(2);
const live = args.includes("--live");
const expectedHead = args.find((a) => a.startsWith("--expected-head="))?.slice(16);
const confirm = args.find((a) => a.startsWith("--confirm="))?.slice(10);
const verify = args.includes("--verify-applied");
const runGit = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

async function main() {
  environmentGates();
  if (runGit("branch", "--show-current") !== "ui/stitch-mobile-redesign") fail("Unexpected branch");
  if (runGit("rev-parse", "--show-toplevel").toLowerCase() !== path.resolve(".").toLowerCase()) fail("Unexpected checkout");
  const head = runGit("rev-parse", "HEAD");
  if (!verify && (head !== expectedHead || runGit("status", "--porcelain"))) fail("Pushed HEAD or clean tree gate failed");
  if (live && confirm !== CONFIRM) fail("Exact staging confirmation required");
  const sql = fs.readFileSync(`supabase/migrations/${VERSION}_${NAME}.sql`, "utf8");
  const { client } = await connectVerified();
  try {
    const migrations = (await client.query("select version from supabase_migrations.schema_migrations order by version")).rows;
    const current = migrations.at(-1)?.version;
    const fn = (await client.query("select pg_get_functiondef('public.enqueue_caterlink_receipt_pdf_job()'::regprocedure) as definition")).rows[0]?.definition;
    if (verify) {
      if (migrations.length !== 100 || current !== VERSION || !fn?.includes("'PEN', 'JHB', 'NILAI', 'KCH', 'BKI'")) fail("Post-apply verification failed");
      console.log(`VERIFY OK: staging ${APPROVED_REF}; migrations=100; latest=${VERSION}; all final destinations covered`);
      return;
    }
    if (migrations.length !== 99 || current !== "20261119000001") fail("Unexpected staging migration baseline");
    if (!fn?.includes("'KCH', 'BKI'") || fn.includes("'PEN', 'JHB', 'NILAI', 'KCH', 'BKI'")) fail("Unexpected pre-change function");
    const fingerprint = crypto.createHash("sha256").update(fn).digest("hex");
    const backup = path.join(os.tmpdir(), `vecta-pdf-enqueue-function-${VERSION}-${fingerprint.slice(0, 12)}.sql`);
    if (fs.existsSync(backup)) {
      if (fs.readFileSync(backup, "utf8") !== fn) fail("Existing function backup differs");
    } else fs.writeFileSync(backup, fn, { flag: "wx", mode: 0o600 });
    console.log(`staging ${APPROVED_REF}; baseline=99; function backup=${backup}; mode=${live ? "LIVE" : "DRY RUN"}`);
    await client.query("begin");
    try {
      await client.query(sql);
      const after = (await client.query("select pg_get_functiondef('public.enqueue_caterlink_receipt_pdf_job()'::regprocedure) as definition")).rows[0]?.definition;
      if (!after?.includes("'PEN', 'JHB', 'NILAI', 'KCH', 'BKI'")) fail("Updated function verification failed");
      if (live) {
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [VERSION, NAME, [sql]]);
        await client.query("commit");
        console.log(`APPLIED ${VERSION} to approved staging`);
      } else {
        await client.query("rollback");
        console.log("DRY RUN OK: migration rolled back");
      }
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
  } finally { await client.end().catch(() => {}); }
}
main().catch((e) => { console.error(`FAILED: ${String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`); process.exitCode = 1; });
