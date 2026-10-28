#!/usr/bin/env node
// Guarded runner for applying the child tables insert policies fix forward migration (20261130000002) to staging.
// Staging ONLY: ddlctzbnqewubltcavkh. Production (zsxneokqulktgnccxgkz) is strictly rejected.
//
// Usage:
//   node --env-file=.env.local scripts/staging/apply-child-policy-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-child-policy-fix-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261130000002 TO STAGING ddlctzbnqewubltcavkh"
//   node --env-file=.env.local scripts/staging/apply-child-policy-fix-migration.mjs --verify-applied                                            (read-only)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261130000002", name: "fix_makeup_breakup_child_insert_policies", sha256: "db8e483a1e9b6af81bd482729eb7e434407cbb0371157c3eb1ca1917990ebad7" },
];

export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
export const PUSHED_BASE = "d42a6eeb3289067b7c06b6afc3d001f7949f4d77";
export const PRE_COUNT = 104;
export const LAST_PRE = "20261130000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^drop policy if exists makeup_baggage_entries_insert on public\.report_makeup_baggage_entries$/,
  /^create policy makeup_baggage_entries_insert on public\.report_makeup_baggage_entries for insert with check \(exists\(select 1 from public\.report_makeup p where p\.id = report_makeup_baggage_entries\.report_id and p\.profile_id = auth\.uid\(\)\)\)$/,
  /^drop policy if exists makeup_discrepancies_insert on public\.report_makeup_discrepancies$/,
  /^create policy makeup_discrepancies_insert on public\.report_makeup_discrepancies for insert with check \(exists\(select 1 from public\.report_makeup p where p\.id = report_makeup_discrepancies\.report_id and p\.profile_id = auth\.uid\(\)\)\)$/,
  /^drop policy if exists breakup_baggage_entries_insert on public\.report_breakup_baggage_entries$/,
  /^create policy breakup_baggage_entries_insert on public\.report_breakup_baggage_entries for insert with check \(exists\(select 1 from public\.report_breakup p where p\.id = report_breakup_baggage_entries\.report_id and p\.profile_id = auth\.uid\(\)\)\)$/,
];

export function statementAudit(sql) {
  const raw = String(sql).replace(/--.*$/gm, "");
  const code = raw.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
  const statements = code
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").replace(/([[(]) /g, "$1").replace(/ ([\])])/g, "$1").trim().toLowerCase())
    .filter(Boolean);
  const bad = statements.find((s) => !ALLOWED_STATEMENTS.some((rx) => rx.test(s)));
  if (bad) return bad.slice(0, 140);
  return null;
}

export function verifyFrozenMigrations(readFile) {
  return MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = readFile(file);
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    const sql = canonicalSql(buf);
    const bad = statementAudit(sql);
    if (bad) fail(`${file} contains a statement outside the reviewed allow-list: ${bad}`);
    return { ...m, file, sql };
  });
}

export function orderingGate(fileNames) {
  const dated = fileNames.filter((f) => /^\d{14}_.*\.sql$/.test(f)).map((f) => f.slice(0, 14)).sort();
  if (new Set(dated).size !== dated.length) fail("duplicate migration versions in the repository");
  const after = dated.filter((v) => v > LAST_PRE && v <= POST_LAST);
  if (after.join() !== MIGRATIONS.map((m) => m.version).join()) fail(`migrations after ${LAST_PRE} other than frozen (${after.join()})`);
  if (!dated.includes(LAST_PRE)) fail(`${LAST_PRE} is not in the repository`);
}

export function runnerGitGates({ expectedHead, repoPath, base = PUSHED_BASE }) {
  if (!/^[0-9a-f]{40}$/.test(String(expectedHead))) fail("--expected-head must be a full 40-character SHA");
  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: repoPath, expectedBranch: RUNNER_BRANCH });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  try { child_process.execSync(`git merge-base --is-ancestor ${base} HEAD`, { stdio: "ignore" }); } catch { fail("HEAD does not descend from the pushed baseline"); }
  return git;
}

export function productionGate(env = process.env, argv = process.argv) {
  if (JSON.stringify(env).includes(FORBIDDEN_REF) || argv.join(" ").includes(FORBIDDEN_REF)) fail("production reference present");
}

export async function verifyPreState(q, ctx) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  if (mig.length !== ctx.preCount || mig[mig.length - 1]?.version !== ctx.lastPre) {
    fail(`history is not exactly ${ctx.preCount} ending ${ctx.lastPre} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  if (mig.some((m) => ctx.files.some((f) => f.version === m.version))) fail("the migration is already recorded in history");
}

export async function verifyApplied(q, ctx = {}) {
  const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
  const expectedCount = ctx.postCount ?? POST_COUNT;
  const expectedLast = ctx.postLast ?? POST_LAST;
  if (mig.length !== expectedCount || mig[mig.length - 1]?.version !== expectedLast) {
    fail(`history is not ${expectedCount} ending ${expectedLast} (found ${mig.length} ending ${mig[mig.length - 1]?.version})`);
  }
  for (const m of MIGRATIONS) {
    if (mig.filter((x) => x.version === m.version && x.name === m.name).length !== 1) {
      fail(`${m.version} is not recorded exactly once with its name`);
    }
  }
  return { history: mig.length, last: mig[mig.length - 1].version };
}

export async function execute(client, ctx) {
  const { acct, log } = ctx;
  const files = ctx.files.map((f) => ({ ...f, sql: canonicalSql(f.sql) }));
  for (const f of files) {
    if (f.sha256 && normalisedSha256(f.sql) !== f.sha256) fail(`${f.file}: SQL does not match frozen SHA-256`);
    const bad = statementAudit(f.sql);
    if (bad) fail(`${f.file} statement audit failed: ${bad}`);
  }
  const q = async (s, p) => (await client.query(s, p)).rows;
  const probes = [];
  const probe = (name) => { probes.push(name); log(`PROBE PASS: ${name}`); };

  await verifyPreState(q, { ...ctx, files });
  log(`hosted pre-state verified: 104 migrations ending 20261130000001`);

  const asRole = async (uid, role, fn) => {
    await client.query("SAVEPOINT pr");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : { role }), role]);
      const res = await fn();
      await client.query("RELEASE SAVEPOINT pr");
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims', '', true)");
      return res;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT pr").catch(() => {});
      await client.query("reset role").catch(() => {});
      await client.query("select set_config('request.jwt.claims', '', true)").catch(() => {});
      return `ERR:${e.code ?? ""}:${String(e.message).slice(0, 110)}`;
    }
  };
  const asUser = (label, fn) => asRole(acct(label), "authenticated", fn);

  async function pass(real) {
    await client.query("BEGIN");
    try {
      for (const f of files) {
        log(`applying ${f.file} in transaction...`);
        await client.query(f.sql);
      }

      // Probe 1: As aso-kul, insert into report_makeup with status='submitted' then child baggage entries succeeds
      const asoId = acct("aso-kul");
      const makeupInsert = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup (profile_id, status, station, team, staff_name, staff_id, flight_number, duty_date, destination, first_baggage_time, last_baggage_tag_time, officer_confirmation)
           values ($1, 'submitted', 'KUL - MAA', 'ALPHA', 'UAT ASO', 'ASO-101', 'AK 888', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'PEN', '08:00', '09:00', true)
           returning id`,
          [asoId]
        );
        return res.rows[0].id;
      });
      if (typeof makeupInsert !== "string" || makeupInsert.startsWith("ERR")) {
        fail(`Probe 1 parent report insert failed: ${makeupInsert}`);
      }
      const makeupId = makeupInsert;

      const bagInsert = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
           values ($1, 1, 'AKE9999AK', 'SL-999', 'B12', 'PEN')
           returning id`,
          [makeupId]
        );
        return res.rows[0].id;
      });
      if (typeof bagInsert !== "string" || bagInsert.startsWith("ERR")) {
        fail(`Probe 1 child baggage insert failed under submitted parent: ${bagInsert}`);
      }
      probe("aso-kul can insert child baggage entry under submitted report_makeup");

      // Probe 2: As aso-kul, insert into report_makeup_discrepancies under submitted report succeeds
      const discInsert = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup_discrepancies (report_id, entry_no, baggage_tag_no, details)
           values ($1, 1, 'TAG-999', 'Tag damaged')
           returning id`,
          [makeupId]
        );
        return res.rows[0].id;
      });
      if (typeof discInsert !== "string" || discInsert.startsWith("ERR")) {
        fail(`Probe 2 child discrepancy insert failed under submitted parent: ${discInsert}`);
      }
      probe("aso-kul can insert child discrepancy under submitted report_makeup");

      // Probe 3: As aso-kul, insert into report_breakup with status='submitted' then child baggage entries succeeds
      const breakupInsert = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_breakup (profile_id, status, station, team, staff_name, staff_id, flight_number, duty_date, origin, first_container_time, last_container_time, containers_inspected_clean)
           values ($1, 'submitted', 'KUL - AAX', 'ALPHA', 'UAT ASO', 'ASO-101', 'D7 999', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'HND', '22:00', '23:00', true)
           returning id`,
          [asoId]
        );
        return res.rows[0].id;
      });
      if (typeof breakupInsert !== "string" || breakupInsert.startsWith("ERR")) {
        fail(`Probe 3 parent breakup insert failed: ${breakupInsert}`);
      }
      const breakupId = breakupInsert;

      const breakupBagInsert = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_breakup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, baggage_tag_no, discrepancy_details)
           values ($1, 1, 'AAP8888AK', 'D7-888', 'Arrival normal')
           returning id`,
          [breakupId]
        );
        return res.rows[0].id;
      });
      if (typeof breakupBagInsert !== "string" || breakupBagInsert.startsWith("ERR")) {
        fail(`Probe 3 child breakup baggage insert failed under submitted parent: ${breakupBagInsert}`);
      }
      probe("aso-kul can insert child baggage entry under submitted report_breakup");

      // Probe 4: Other user (so-kul) denied inserting child rows for aso-kul's report
      const rogueInsert = await asUser("so-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
           values ($1, 2, 'AKE0000AK', 'SL-000', 'B12', 'PEN')
           returning id`,
          [makeupId]
        );
        return res.rows[0].id;
      });
      if (typeof rogueInsert === "string" && !rogueInsert.startsWith("ERR")) {
        fail(`Probe 4 cross-user child insert was unexpectedly allowed: ${rogueInsert}`);
      }
      probe("so-kul denied inserting child entry into aso-kul report_makeup");

      // Probe 5: Attempting to UPDATE or DELETE the inserted child rows on submitted report is blocked by trigger
      const badUpdate = await asUser("aso-kul", async () => {
        await client.query(`update public.report_makeup_baggage_entries set bay = 'B99' where id = $1`, [bagInsert]);
        return "UPDATED";
      });
      if (badUpdate === "UPDATED" || !String(badUpdate).includes("Cannot modify entries of a submitted report")) {
        fail(`Probe 5 update on submitted report child row was not blocked: ${badUpdate}`);
      }
      probe("block_submitted_child_mutation trigger strictly blocks update on submitted child entries");

      if (real) {
        log("recording migration in supabase_migrations.schema_migrations...");
        await client.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [files[0].version, files[0].name]);
        await client.query("COMMIT");
        log("LIVE TRANSACTION COMMITTED.");
      } else {
        await client.query("ROLLBACK");
        log("DRY RUN TRANSACTION ROLLED BACK.");
      }
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  }

  log("\n--- STAGE 1: Transactional dry run with 5 behavioral probes ---");
  await pass(false);

  log("\n--- STAGE 2: Verifying pre-state preserved after rollback ---");
  await verifyPreState(q, { ...ctx, files });
  log("Pre-state verified: zero remnants from dry run.");

  if (ctx.live) {
    log("\n--- STAGE 3: LIVE PASS ---");
    await pass(true);
    log("\n--- STAGE 4: Verifying applied schema and history ---");
    const verified = await verifyApplied(q, { ...ctx, files });
    log(`Migration successfully verified live: history = ${verified.history}, last = ${verified.last}`);
  } else {
    log("\nDRY RUN SUCCESSFUL. Pass --live --confirm=\"<LIVE_PHRASE>\" to apply.");
  }

  return { probesCount: probes.length };
}

async function main() {
  const argv = process.argv.slice(2);
  productionGate(process.env, argv);

  const isLive = argv.includes("--live");
  const isVerify = argv.includes("--verify-applied");
  const expectedHeadArg = argv.find((a) => a.startsWith("--expected-head="))?.split("=")[1];
  const backupArg = argv.find((a) => a.startsWith("--backup="))?.split("=")[1];
  const confirmArg = argv.find((a) => a.startsWith("--confirm="))?.split("=")[1];

  const repoPath = path.resolve(import.meta.dirname, "../..");
  const sqlDir = path.join(repoPath, "supabase/migrations");

  const readFile = (file) => fs.readFileSync(path.join(sqlDir, file));
  const frozen = verifyFrozenMigrations(readFile);
  orderingGate(fs.readdirSync(sqlDir));

  if (isVerify) {
    const { client } = await connectVerified();
    try {
      const res = await verifyApplied((s, p) => client.query(s, p).then((r) => r.rows));
      console.log(`VERIFIED APPLIED: history = ${res.history}, last = ${res.last}`);
    } finally {
      await client.end();
    }
    return;
  }

  if (!expectedHeadArg) fail("--expected-head=<sha> is required");
  const git = runnerGitGates({ expectedHead: expectedHeadArg, repoPath });

  if (!backupArg) fail("--backup=<fresh.enc.json> is required");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(backupArg, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(backupArg)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  console.log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  if (isLive && confirmArg !== LIVE_PHRASE) {
    fail(`Confirmation phrase mismatch. Expected: --confirm="${LIVE_PHRASE}"`);
  }

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? manifest.find((a) => a.label === label)?.id ?? fail(`manifest has no ${label}`);

  const { client } = await connectVerified();
  try {
    await execute(client, {
      files: frozen,
      acct,
      live: isLive,
      log: console.log,
      preCount: PRE_COUNT,
      lastPre: LAST_PRE,
      postCount: POST_COUNT,
      postLast: POST_LAST,
    });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
}
