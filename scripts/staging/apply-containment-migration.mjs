#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261108000001_caterlink_fail_closed_containment.sql to the approved staging project.
// A complete transactional DRY RUN (apply, verify, behavioural probe, ROLLBACK) always comes first; only with --live and the exact phrase is
// the real application committed (migration + history row atomically). Prints names and counts only.
//
// Gates: exact repo / branch / origin, clean tree, HEAD == --expected-head; approved staging ref only and the production ref absent;
// verified TLS; existing encrypted backups AND the fresh backup (< 6 h, outside the repo, same Auth-user count) authenticate; hosted
// history is exactly 83 migrations ending 20261107000001; the migration matches its frozen SHA-256 (LF-normalised).
//
//   node --env-file=.env.local scripts/staging/apply-containment-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-containment-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261108000001 TO STAGING ddlctzbnqewubltcavkh"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const VERSION = "20261108000001";
export const NAME = "caterlink_fail_closed_containment";
export const SHA256 = "40da2d9da4e9bbeaa75b4d3a3f991b830fa74cce43b10f4e8a25e902aaf11df9";
export const PRE_COUNT = 83;
export const LAST_PRE = "20261107000001";
export const LIVE_PHRASE = `APPLY ${VERSION} TO STAGING ${APPROVED_REF}`;
const SKIP = "public.skip_part_d(uuid, text)";
const RAISE = "public.raise_caterlink_incident_secure(uuid, text, text, text, text)";
const RECEIPT = "public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text)";
const LIST = "public.list_caterlink_pending_receipts_secure(text)";

export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const LIVE = args.includes("--live");
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");
const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `containment-${process.pid}.log`), l + "\n"); };

async function main() {
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`containment migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

  const git = gitGates({ expectedBase: expectedHead, expectedRepoPath: path.resolve(import.meta.dirname, "../..") });
  if (git.head !== expectedHead) fail("HEAD is not the expected head");
  log(`HEAD=${git.head.slice(0, 12)}; branch and origin verified; working tree clean`);
  environmentGates();
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("production reference present");
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (!path.relative(git.root, path.resolve(freshBackup)).startsWith("..")) fail("fresh backup is inside the repository");
  if (!nb.exportedAt || Date.now() - new Date(nb.exportedAt).getTime() > 6 * 3600 * 1000) fail("fresh backup is older than 6 hours");
  log(`existing backups authenticate (x${backups.length}); fresh backup authenticates (exportedAt=${nb.exportedAt}, authUsers=${nb.authUsers?.length})`);

  const file = `${VERSION}_${NAME}.sql`;
  const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
  const sha = normalisedSha256(buf);
  if (sha !== SHA256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${SHA256}`);
  const sql = buf.toString("utf8");
  const migDir = fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  if (migDir.filter((f) => f.slice(0, 14) > LAST_PRE).join() !== file) fail("the repository holds a migration after the last applied one that is not the frozen containment migration");
  if (/drop table|truncate|delete from/i.test(sql.replace(/--.*$/gm, ""))) fail("the migration contains a destructive statement");
  log(`${file} matches its frozen hash (${sql.length} bytes) and is the only migration after ${LAST_PRE}`);

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`history is not exactly ${PRE_COUNT} ending ${LAST_PRE}`);
    if (mig.some((m) => m.version === VERSION)) fail("the containment migration is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
    if ((await q("select count(*)::int n from auth.users"))[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    if ((await q("select to_regprocedure('public.caterlink_receipt_ready_statuses(text,text)') r"))[0].r) fail("the receipt state helper already exists on staging");

    const grants = async () => q(`select p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
      has_function_privilege('service_role', p.oid, 'execute') svc, exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') pub
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure') order by 1`);
    const before = await grants();
    for (const g of before) log(`BEFORE ${g.sig}: anon=${g.anon} authenticated=${g.auth} service_role=${g.svc} PUBLIC=${g.pub}`);
    const fp = async () => ({
      other: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname not in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure','caterlink_receipt_ready_statuses') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
      profiles: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) h from public.profiles p"))[0].h,
      assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
      transactions: (await q("select coalesce(md5(string_agg(md5(t::text), ',' order by t.id::text)), 'none') h from public.transactions t"))[0].h,
      incidents: (await q("select count(*)::text h from public.caterlink_incidents"))[0].h,
      hub: (await q("select count(*)::text h from public.caterlink_checkpoint_hub"))[0].h,
      jobs: (await q("select count(*)::text h from public.caterlink_pdf_jobs"))[0].h,
      policies: (await q("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    });
    const pre = await fp();
    const defs = await q(`select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure')`);
    const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-containment-prechange-${Date.now()}.enc.json`);
    fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, grants: before, functionDefinitions: defs, fingerprints: pre }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change snapshot (grants, function definitions, fingerprints) written and re-authenticated (${path.basename(snap)})`);

    async function pass(real) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [VERSION, NAME, [sql]]);
        if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT + 1) fail("unexpected history count");

        const after = await grants();
        for (const g of after) {
          const closed = /skip_part_d|raise_caterlink_incident_secure/.test(g.sig);
          if (closed && (g.anon || g.auth || g.svc || g.pub)) fail(`${g.sig} is still executable by a role`);
          if (!closed && (g.anon || g.pub || !g.auth || !g.svc)) fail(`${g.sig} grants are not anon/PUBLIC-denied and authenticated+service_role-granted`);
        }
        for (const sig of [SKIP, RAISE]) {
          const body = (await q(`select pg_get_functiondef('${sig}'::regprocedure) d`))[0].d;
          if (!/raise exception 'Not available\./.test(body) || /current_user_role|insert into|update public/i.test(body)) fail(`${sig} is not a bare fail-closed stub`);
        }
        const rbody = (await q(`select pg_get_functiondef('${RECEIPT}'::regprocedure) d`))[0].d;
        const lock = rbody.indexOf("FOR UPDATE"); const gate = rbody.indexOf("caterlink_receipt_ready_statuses"); const write = rbody.search(/INSERT INTO public\.caterlink_checkpoint_hub|UPDATE public\.transactions/);
        if (!(lock > 0 && gate > lock && write > gate)) fail("the receipt does not lock, then gate on state, before writing");
        if (!/caterlink_receipt_ready_statuses/.test((await q(`select pg_get_functiondef('${LIST}'::regprocedure) d`))[0].d)) fail("the pending list does not use the state rule");
        const states = (await q("select public.caterlink_receipt_ready_statuses('OUTBOUND','HUB') h, public.caterlink_receipt_ready_statuses('OUTBOUND','MAINTENANCE') m, public.caterlink_receipt_ready_statuses('OUTBOUND','AIRCRAFT') a, public.caterlink_receipt_ready_statuses('INBOUND','AIRCRAFT') i, public.caterlink_receipt_ready_statuses('OUTBOUND','REDQ') r"))[0];
        if (states.h.join() !== "INFLIGHT_POST_APPROVED" || states.m.join() !== "INFLIGHT_POST_APPROVED" || states.a.join() !== "AIRPORT_POST_APPROVED,POST6_APPROVED" || states.i.join() !== "AIRPORT_POST_APPROVED,POST6_APPROVED" || states.r.join() !== "AIRPORT_POST_APPROVED,POST6_APPROVED") fail("the receivable-state table is not the derived one");

        // behavioural probes (rolled back with everything else)
        const asUser = async (label, fn) => {
          await client.query("SAVEPOINT pr");
          try {
            await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: acct(label), role: "authenticated" })]);
            return await fn();
          } catch (e) { return `ERR:${String(e.message).slice(0, 90)}`; } finally { await client.query("ROLLBACK TO SAVEPOINT pr"); }
        };
        const ghost = "00000000-0000-4000-8000-000000000c01";
        for (const label of ["aso", "aso-kul", "caterlink_management", "operation_manager", "super_admin", "neg-pending-profile", "caterlink-driver", "caterlink-vendor"]) {
          const s = await asUser(label, async () => { await client.query("select public.skip_part_d($1, 'x')", [ghost]); return "ALLOWED"; });
          const r = await asUser(label, async () => { await client.query("select * from public.raise_caterlink_incident_secure($1, 'OTHER', 'x', 'low', null)", [ghost]); return "ALLOWED"; });
          if (!/permission denied/i.test(s) || !/permission denied/i.test(r)) fail(`${label} can still reach skip_part_d / raise_caterlink_incident_secure (${s} | ${r})`);
        }
        // receipt gate on a synthetic movement (rolled back): CREATED is refused, the final-step state is accepted, nothing leaks on refusal
        await client.query("SAVEPOINT rc");
        const aoc = (await q("select id from public.aocs where code = 'MY'"))[0].id;
        const pen = (await q("select id from public.org_stations where code = 'PEN'"))[0].id;
        const kch = (await q("select id from public.org_stations where code = 'KCH'"))[0].id;
        await client.query("set local session_replication_role = replica");
        const tx = (await q(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, flight_number, created_by)
          values ('ICMS-2026-990999', $1, 'OUTBOUND', 'UAT-VEH', '[CONTAINMENT-DRYRUN]', 'UAT-DRV', 'S', 'CREATED', 'AIRCRAFT', $2, $3, 'AK9001', $4) returning id`, [aoc, pen, kch, acct("caterlink-driver")]))[0].id;
        await client.query("set local session_replication_role = origin");
        const rcpt = async () => asUser("aso-kch-receipt", async () => { await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'KCH', 'receipt/dryrun.png', 'dry run')`, [tx]); return "ACCEPTED"; });
        const denied = await rcpt();
        if (!/not ready for receipt/i.test(denied)) fail(`a CREATED movement was not refused by the state gate (${denied})`);
        const leak = (await q("select (select count(*) from public.caterlink_checkpoint_hub where transaction_id = $1)::int + (select count(*) from public.caterlink_pdf_jobs where transaction_id = $1)::int + (select count(*) from public.phase8_audit_log where entity_id = $1)::int n", [tx]))[0].n;
        if (leak !== 0) fail("a refused receipt wrote a hub record, PDF job or audit row");
        await client.query("update public.transactions set status = 'AIRPORT_POST_APPROVED' where id = $1", [tx]);
        const okRcpt = await asUser("aso-kch-receipt", async () => { const r = await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'KCH', 'receipt/dryrun.png', 'dry run')`, [tx]); return `ACCEPTED:${r.rows[0].status}`; });
        if (okRcpt !== "ACCEPTED:COMPLETED") fail(`the final-step state was not accepted (${okRcpt})`);
        await client.query("ROLLBACK TO SAVEPOINT rc");

        const post = await fp();
        for (const k of ["other", "profiles", "assignments", "transactions", "incidents", "hub", "jobs", "policies"]) {
          if (post[k] !== pre[k]) fail(`an unrelated ${k} fingerprint changed`);
        }
        log(`${real ? "APPLY" : "DRY RUN"}: verification PASSED (history once; skip_part_d and raise_caterlink_incident_secure closed to PUBLIC/anon/authenticated/service_role and denied to eight personas; receipt locks then gates on state and writes nothing when refused; final-step receipt accepted; synthetic probe rolled back; no unrelated function, policy, profile, assignment, transaction, incident, hub or job row changed)`);
        for (const g of after) log(`AFTER  ${g.sig}: anon=${g.anon} authenticated=${g.auth} service_role=${g.svc} PUBLIC=${g.pub}`);
        if (!real) { await client.query("ROLLBACK"); log("DRY RUN: rolled back, no change made"); return; }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); log(`${real ? "APPLY" : "DRY RUN"} ROLLED BACK: ${redact(e.message)}`); throw e; }
    }
    await pass(false);
    if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT || (await q("select to_regprocedure('public.caterlink_receipt_ready_statuses(text,text)') r"))[0].r) fail("the dry run left a change behind");
    const afterDry = await grants();
    if (JSON.stringify(afterDry) !== JSON.stringify(before)) fail("the dry run changed a grant");
    log("dry run left staging exactly as before (history count, helper absence and grants re-checked)");
    if (!LIVE) return;
    await pass(true);
    if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [VERSION])).length !== 1) fail("post-commit history check failed");
    log(`APPLIED ${VERSION} (committed, recorded once)`);
    log("RESULT: SUCCESS");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
