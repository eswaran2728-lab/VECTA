#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261107000001_caterlink_part_b_checkpoint.sql to the approved staging project.
// A complete transactional DRY RUN (apply, verify, ROLLBACK) always comes first; only with --live and the exact phrase is the real
// application committed (migration + history row atomically). Prints names and counts only.
//
// Gates: exact repo / branch / origin, clean tree, HEAD == --expected-head; approved staging ref only and the production ref absent;
// verified TLS; existing encrypted backups AND the fresh backup (< 6 h, outside the repo, same Auth-user count) authenticate; hosted
// history is exactly 82 migrations ending 20261106000002; the migration matches its frozen SHA-256 (LF-normalised).
//
//   node --env-file=.env.local scripts/staging/apply-part-b-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-part-b-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261107000001 TO STAGING ddlctzbnqewubltcavkh"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

export const VERSION = "20261107000001";
export const NAME = "caterlink_part_b_checkpoint";
export const SHA256 = "2b439edd6480d268ff75e26877c174ea67aa431ba50a05a62970a3f18fa67e7c";
export const PRE_COUNT = 82;
export const LAST_PRE = "20261106000002";
export const LIVE_PHRASE = `APPLY ${VERSION} TO STAGING ${APPROVED_REF}`;
const RPC = "public.record_caterlink_part_b_secure(uuid, boolean, boolean, jsonb, jsonb, text, text, text, text, text, text, text, text)";

export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const LIVE = args.includes("--live");
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");
const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `part-b-${process.pid}.log`), l + "\n"); };

async function main() {
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`Part B migration: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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
  if (migDir.filter((f) => f.slice(0, 14) > LAST_PRE).join() !== file) fail("the repository holds a migration after the last applied one that is not the frozen Part B migration");
  if (/drop table|truncate|delete from/i.test(sql.replace(/--.*$/gm, ""))) fail("the migration contains a destructive statement");
  log(`${file} matches its frozen hash (${sql.length} bytes) and is the only migration after ${LAST_PRE}`);

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`history is not exactly ${PRE_COUNT} ending ${LAST_PRE}`);
    if (mig.some((m) => m.version === VERSION)) fail("the Part B migration is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
    if ((await q("select count(*)::int n from auth.users"))[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    if ((await q("select to_regprocedure($1) r", [RPC]))[0].r) fail("the Part B RPC already exists on staging");
    if ((await q("select 1 from pg_trigger where tgname = 'trg_part_b_c_immutable'")).length) fail("the immutability trigger already exists on staging");

    const fp = async () => ({
      other: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname not in ('record_caterlink_part_b_secure','caterlink_checkpoint_escalate_internal','part_b_c_immutable') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
      profiles: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) h from public.profiles p"))[0].h,
      assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
      partB: (await q("select count(*)::text h from public.part_b_c"))[0].h,
      transactions: (await q("select md5(string_agg(md5(t::text), ',' order by t.id::text)) h from public.transactions t"))[0].h,
      policies: (await q("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
    });
    const pre = await fp();
    const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-part-b-prechange-${Date.now()}.enc.json`);
    const eventDef = (await q("select pg_get_constraintdef(c.oid) d from pg_constraint c where c.conname = 'user_notifications_event_type_check'"))[0]?.d ?? null;
    fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, fingerprints: pre, notificationEventConstraint: eventDef }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change snapshot written and re-authenticated (${path.basename(snap)}); part_b_c rows=${pre.partB}`);

    async function pass(real) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [VERSION, NAME, [sql]]);
        if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT + 1) fail("unexpected history count");

        const priv = (await q(`select has_function_privilege('anon', '${RPC}'::regprocedure, 'execute') an, has_function_privilege('authenticated', '${RPC}'::regprocedure, 'execute') au, has_function_privilege('service_role', '${RPC}'::regprocedure, 'execute') sv, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${RPC}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub, (select prosecdef from pg_proc where oid = '${RPC}'::regprocedure) sd, (select coalesce(proconfig,'{}') from pg_proc where oid = '${RPC}'::regprocedure) cfg`))[0];
        if (priv.an || priv.pub || !priv.au || !priv.sv || !priv.sd || !priv.cfg.some((x) => x === "search_path=public" || x.startsWith("search_path="))) fail("RPC grants / SECURITY DEFINER / search_path are not as expected");
        for (const internal of ["public.caterlink_checkpoint_escalate_internal(uuid, uuid, text, text, text, uuid)", "public.part_b_c_immutable()"]) {
          const g = (await q(`select has_function_privilege('anon', '${internal}'::regprocedure, 'execute') an, has_function_privilege('authenticated', '${internal}'::regprocedure, 'execute') au, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${internal}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub`))[0];
          if (g.an || g.au || g.pub) fail(`${internal} is callable by a client role`);
        }
        const body = (await q(`select pg_get_functiondef('${RPC}'::regprocedure) d`))[0].d;
        if (/can_user_scan_caterlink/.test(body)) fail("the RPC references the application-layer scan decision");
        if (!/auth\.uid\(\)/.test(body) || !/for update/i.test(body)) fail("the RPC does not derive the actor from auth.uid() / lock the transaction row");
        const trg = await q("select tgenabled from pg_trigger where tgname = 'trg_part_b_c_immutable' and tgrelid = 'public.part_b_c'::regclass");
        if (trg.length !== 1 || trg[0].tgenabled !== "O") fail("the immutability trigger is missing or disabled");
        if ((await q("select 1 from pg_indexes where schemaname='public' and indexname = 'part_b_c_one_per_stage'")).length !== 1) fail("the one-record-per-stage unique index is missing");
        const ev = (await q("select pg_get_constraintdef(c.oid) d from pg_constraint c where c.conname = 'user_notifications_event_type_check'"))[0]?.d ?? "";
        if (!ev.includes("caterlink_checkpoint_escalated")) fail("the notification event type was not added");
        if (eventDef) for (const old of [...eventDef.matchAll(/'([a-z_:]+)'::text/g)].map((m) => m[1])) if (!ev.includes(`'${old}'`)) fail(`existing notification event type '${old}' was lost`);
        // grants on part_b_c are not widened (no direct client write path is added)
        const direct = (await q("select has_table_privilege('anon','public.part_b_c','insert,update,delete') a")).map((r) => r.a)[0];
        if (direct) fail("anon can write part_b_c");
        // behavioural: anonymous cannot call the RPC; an authenticated caller with no usable identity is refused uniformly (rolled back)
        await client.query("SAVEPOINT an");
        const anon = await client.query("set local role anon").then(() => client.query(`select * from ${RPC.replace(/\(.*$/, "")}('00000000-0000-0000-0000-000000000000', true, true, '{}'::jsonb, '{}'::jsonb, 'x', 'x', 'x', 'x', 'x', 'x', 'PASS', '')`)).then(() => "allowed").catch((e) => (/permission denied/i.test(e.message) ? "denied" : `error:${redact(e.message).slice(0, 60)}`));
        await client.query("ROLLBACK TO SAVEPOINT an");
        if (anon !== "denied") fail(`anonymous RPC call was not denied (${anon})`);
        await client.query("SAVEPOINT nu");
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: "00000000-0000-0000-0000-0000000000aa", role: "authenticated" })]);
        const nobody = await client.query(`select * from ${RPC.replace(/\(.*$/, "")}('00000000-0000-0000-0000-000000000000', true, true, '{}'::jsonb, '{}'::jsonb, 'x', 'x', 'x', 'x', 'x', 'x', 'PASS', '')`).then(() => "allowed").catch(() => "refused");
        await client.query("ROLLBACK TO SAVEPOINT nu");
        if (nobody !== "refused") fail("an unknown authenticated identity was not refused");
        const post = await fp();
        for (const k of ["other", "profiles", "assignments", "partB", "transactions", "policies"]) {
          if (post[k] !== pre[k]) fail(`an unrelated ${k} fingerprint changed`);
        }
        log(`${real ? "APPLY" : "DRY RUN"}: verification PASSED (history once; RPC SECURITY DEFINER, anon/PUBLIC denied, authenticated granted; internal helpers not client-callable; immutability trigger enabled; unique index present; notification constraint extended without loss; anonymous and unknown identities refused; no unrelated function, policy, profile, assignment or transaction changed)`);
        if (!real) { await client.query("ROLLBACK"); log("DRY RUN: rolled back, no change made"); return; }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); log(`${real ? "APPLY" : "DRY RUN"} ROLLED BACK: ${redact(e.message)}`); throw e; }
    }
    await pass(false);
    if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT || (await q("select to_regprocedure($1) r", [RPC]))[0].r) fail("the dry run left a change behind");
    log("dry run left staging exactly as before (history count and RPC absence re-checked)");
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
