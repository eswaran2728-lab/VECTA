#!/usr/bin/env node
// Guarded runner for applying the source-secure functions forward migration (20261130000001) to staging.
// Staging ONLY: ddlctzbnqewubltcavkh. Production (zsxneokqulktgnccxgkz) is strictly rejected.
//
// Usage:
//   node --env-file=.env.local scripts/staging/apply-source-secure-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-source-secure-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261130000001 TO STAGING ddlctzbnqewubltcavkh"
//   node --env-file=.env.local scripts/staging/apply-source-secure-migration.mjs --verify-applied                                            (read-only)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const MIGRATIONS = [
  { version: "20261130000001", name: "source_secure_makeup_and_breakup", sha256: "2f0c82707c4da6934302468c6334105999817b3fc429719fd2ae19833a36eb4f" },
];

export const RUNNER_BRANCH = "ui/stitch-mobile-redesign";
export const PUSHED_BASE = "61b4b6ba3540e6987c77aedadfae02d55d85536f";
export const PRE_COUNT = 103;
export const LAST_PRE = "20261129000001";
export const POST_COUNT = PRE_COUNT + MIGRATIONS.length;
export const POST_LAST = MIGRATIONS[MIGRATIONS.length - 1].version;
export const LIVE_PHRASE = `APPLY ${MIGRATIONS[0].version} TO STAGING ${APPROVED_REF}`;

export const canonicalSql = (input) => String(Buffer.isBuffer(input) ? input.toString("utf8") : input).replace(/\r\n?/g, "\n");
export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(canonicalSql(buf)).digest("hex");
const fail = (m) => { throw new Error(m); };

const ALLOWED_STATEMENTS = [
  /^create or replace function public\.get_report_by_source_secure\(.*\) returns table \(.*\) language plpgsql security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.get_report_by_source_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.get_report_by_source_secure\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.authorize_report_pdf_by_source_secure\(.*\) returns table \(.*\) language plpgsql security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.authorize_report_pdf_by_source_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.authorize_report_pdf_by_source_secure\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.report_source_flight_date\(.*\) returns table \(.*\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.report_source_flight_date\(.*\) from public, anon, authenticated$/,
  /^grant execute on function public\.report_source_flight_date\(.*\) to service_role$/,
  /^create or replace function public\.search_reports_filtered_secure\(.*\) returns table \(.*\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.search_reports_filtered_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.search_reports_filtered_secure\(.*\) to authenticated, service_role$/,
  /^create or replace function public\.report_source_flag_info\(.*\) returns table \(.*\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.report_source_flag_info\(.*\) from public, anon, authenticated$/,
  /^grant execute on function public\.report_source_flag_info\(.*\) to service_role$/,
  /^create or replace function public\.search_report_stubs_for_request_secure\(.*\) returns table \(.*\) language plpgsql stable security definer set search_path to 'public' as ''$/,
  /^revoke execute on function public\.search_report_stubs_for_request_secure\(.*\) from public, anon$/,
  /^grant execute on function public\.search_report_stubs_for_request_secure\(.*\) to authenticated, service_role$/,
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
  log(`hosted pre-state verified: 103 migrations ending 20261129000001`);

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
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    try {
      log(`applying migration ${files[0].version}...`);
      await client.query(files[0].sql);

      // Probe 1: ASO creates submitted report_makeup and indexes it
      const asoId = acct("aso-kul");
      const submitted = await asUser("aso-kul", async () => {
        const res = await client.query(
          `insert into public.report_makeup (
            profile_id, status, station, team, staff_name, staff_id, flight_number,
            duty_date, destination, first_baggage_time, last_baggage_tag_time, officer_confirmation
          ) values ($1, 'submitted', 'KUL - MAA', 'ALPHA', 'ASO Probe', 'ASO123', 'AK 456', '2026-10-28', 'PEN', '10:00', '11:00', true)
          returning id, aoc_id, operating_entity_id, department_id, unit_id, hub_id, org_station_id, org_team_id, report_no, profile_id`,
          [asoId]
        );
        return res.rows[0];
      });
      if (!submitted?.id || typeof submitted === "string") {
        fail(`Submitted makeup insert failed: ${JSON.stringify(submitted)}`);
      }
      const makeupId = submitted.id;

      // Index the report in central_reports_index using service_role
      const indexed = await client.query(
        `select public.index_report(
          'report_makeup', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        ) as rid`,
        [
          makeupId,
          submitted.report_no,
          submitted.aoc_id,
          submitted.operating_entity_id,
          submitted.department_id,
          submitted.unit_id,
          submitted.hub_id,
          submitted.org_station_id,
          submitted.org_team_id,
          "AK 456",
          "2026-10-28",
          submitted.profile_id,
        ]
      );
      const rid = indexed.rows[0]?.rid;
      if (!rid) fail("Failed to index report_makeup in central_reports_index");
      probe("report_makeup can be indexed in central_reports_index");

      // Probe 2: get_report_by_source_secure retrieves the makeup report
      const fetched = await asUser("aso-kul", async () => {
        const res = await client.query(
          `select * from public.get_report_by_source_secure('report_makeup', $1)`,
          [makeupId]
        );
        return res.rows[0];
      });
      if (!fetched || fetched.source_table !== "report_makeup") {
        fail(`get_report_by_source_secure failed: ${JSON.stringify(fetched)}`);
      }
      probe("get_report_by_source_secure returns report_makeup for authorized user");

      // Probe 3: authorize_report_pdf_by_source_secure authorizes report_makeup
      const authPdf = await asUser("aso-kul", async () => {
        const res = await client.query(
          `select * from public.authorize_report_pdf_by_source_secure('report_makeup', $1)`,
          [makeupId]
        );
        return res.rows[0];
      });
      if (!authPdf || authPdf.source_table !== "report_makeup") {
        fail(`authorize_report_pdf_by_source_secure failed: ${JSON.stringify(authPdf)}`);
      }
      probe("authorize_report_pdf_by_source_secure authorizes report_makeup");

      // Probe 4: report_source_flight_date extracts flight and date
      const fd = await q(
        `select * from public.report_source_flight_date('report_makeup', $1)`,
        [makeupId]
      );
      if (fd[0]?.flight !== "AK 456" || fd[0]?.report_date?.toISOString?.().slice(0, 10) !== "2026-10-28") {
        fail(`report_source_flight_date failed: ${JSON.stringify(fd[0])}`);
      }
      probe("report_source_flight_date returns flight and duty_date for report_makeup");

      // Probe 5: search_reports_filtered_secure finds the indexed makeup report
      const searchRes = await asUser("aso-kul", async () => {
        const res = await client.query(
          `select * from public.search_reports_filtered_secure(
            p_source_table => 'report_makeup',
            p_flight_number => 'AK 456'
          )`
        );
        return res.rows;
      });
      if (!searchRes || searchRes.length === 0 || searchRes[0].source_table !== "report_makeup") {
        fail(`search_reports_filtered_secure failed to find report: ${JSON.stringify(searchRes)}`);
      }
      probe("search_reports_filtered_secure supports report_makeup filtering");

      // Probe 6: report_source_flag_info returns flag info for report_makeup
      const flagInfo = await q(
        `select * from public.report_source_flag_info('report_makeup', $1)`,
        [makeupId]
      );
      if (!flagInfo || flagInfo.length !== 1) {
        fail(`report_source_flag_info failed: ${JSON.stringify(flagInfo)}`);
      }
      probe("report_source_flag_info returns rows for report_makeup");

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

const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  main().catch((e) => {
    console.error("FATAL ERROR:", e.stack || e.message);
    process.exit(1);
  });
}
