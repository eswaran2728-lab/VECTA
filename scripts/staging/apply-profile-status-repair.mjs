#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261027000001_station_visibility_requires_approved_profile.sql to the approved staging
// project: a complete transactional DRY RUN (apply, verify, real-role probes, ROLLBACK) first, then the real application, with the
// migration and its history row committed atomically. Prints names/counts only.
//
// Gates: exact repo/branch/origin, clean tree, HEAD descends from the authorized base; approved staging ref only and the production
// ref absent; verified TLS; original + fresh encrypted backups authenticate; history is exactly 67 migrations ending
// 20261026000002; the migration file matches its frozen SHA-256; the hosted helper is exactly the expected pre-state.
//
// Usage: node --env-file=.env.local scripts/staging/apply-profile-status-repair.mjs --expected-base=<sha> --backup=<path> [--dry-run-only]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DRY_ONLY = args.includes("--dry-run-only");
const expectedBase = argVal("expected-base");
const freshBackup = argVal("backup");

const MIGRATION = { version: "20261027000001", name: "station_visibility_requires_approved_profile", sha256: "809591f461b95f7bc93a835fa467c06eff3358acbda94428571c7f8009912ab6" };
const PRE_COUNT = 67;
const LAST_PRE = "20261026000002";
const PRE_HELPER_MD5 = "cb95013ac1a3764c321653bde343e0f9";
const HELPER = "public.has_station_assignment_for_transaction(uuid,uuid,uuid)";

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `profile-status-repair-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function fingerprints(client) {
  const f = async (s) => (await client.query(s)).rows[0].v;
  const cnt = async (t) => f(`select count(*)::text v from public.${t}`);
  return {
    auth: await f("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) v from auth.users u"),
    profiles: await f("select md5(string_agg(md5(p::text), ',' order by p.id::text)) v from public.profiles p"),
    assignments: await f("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') v from public.user_role_assignments a"),
    usersTable: await f("select coalesce(md5(string_agg(md5(u::text), ',' order by u.id::text)), 'none') v from public.users u"),
    capabilities: await f("select md5(string_agg(md5(c::text), ',' order by c.id::text)) v from public.caterlink_station_capabilities c"),
    // every other public function, byte for byte (covers scan, receipt, workflow and storage functions)
    otherFunctions: await f(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) v from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.oid <> '${HELPER}'::regprocedure and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`),
    policies: await f("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) v from pg_policies where schemaname in ('public','storage')"),
    workflow: [await cnt("transactions"), await cnt("seals"), await cnt("caterlink_checkpoint_part_a"), await cnt("part_b_c"), await cnt("caterlink_vendor_deliveries"), await cnt("caterlink_vendor_checkpoints"), await cnt("caterlink_incidents"), await cnt("vehicles"), await cnt("drivers"), await cnt("catering_companies")].join("/"),
    transactionsFp: await f("select coalesce(md5(string_agg(md5(t::text), ',' order by t.id::text)), 'none') v from public.transactions t"),
    storageObjects: await f("select count(*)::text v from storage.objects"),
  };
}

async function main() {
  if (!expectedBase || !freshBackup) fail("--expected-base and --backup are required");
  log(`profile-status repair: ${DRY_ONLY ? "DRY RUN ONLY" : "dry run, then APPLY"} starting`);
  const git = gitGates({ expectedBase, expectedRepoPath: path.resolve(import.meta.dirname, "../.."), extraAllowed: [/^supabase\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/] });
  log(`HEAD=${git.head} base=${expectedBase.slice(0, 12)}; branch and origin verified; working tree clean`);
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (path.relative(git.root, path.resolve(freshBackup)).startsWith("..") === false) fail("Fresh backup is inside the repository");
  if ((nb.authUsers?.length ?? 0) !== 56) fail(`Fresh backup lists ${nb.authUsers?.length} Auth users, expected 56`);
  log(`existing backups authenticate: original x${backups.length}; fresh backup exportedAt=${nb.exportedAt} authUsers=${nb.authUsers.length}`);

  const file = `${MIGRATION.version}_${MIGRATION.name}.sql`;
  const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== MIGRATION.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${MIGRATION.sha256}`);
  const sql = buf.toString("utf8");
  const defs = [...sql.replace(/--.*$/gm, "").matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1]);
  if (defs.length !== 1 || defs[0] !== "has_station_assignment_for_transaction" || /create policy|drop policy|alter table|grant |revoke /i.test(sql.replace(/--.*$/gm, ""))) fail("migration changes more than the one helper");
  log(`migration file matches the frozen hash (${sha.slice(0, 16)}...) and changes only has_station_assignment_for_transaction()`);

  const manifest = loadCurrentManifest();
  const idOf = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const fx = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-e2e-fixtures.json"), "utf8"));

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  let committed = false;
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`History is not exactly ${PRE_COUNT} ending ${LAST_PRE}`);
    if (mig.some((m) => m.version === MIGRATION.version)) fail("The repair is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference in migration history");
    const helperPre = (await q(`select md5(pg_get_functiondef('${HELPER}'::regprocedure)) h`))[0].h;
    if (helperPre !== PRE_HELPER_MD5) fail(`hosted helper differs from the expected pre-state (${helperPre})`);
    const pre = await fingerprints(client);
    log(`pre-state verified: 67 migrations, helper = expected pre-state, workflow counts ${pre.workflow}`);

    // the movement and signature used by the probes
    // a fixture movement whose Part A signature is a real storage object (referenced list written by verify-storage-staging.mjs)
    const probeFx = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-storage-probe-fixtures.json"), "utf8"));
    const partA = (await q("select transaction_id, signature_url from public.caterlink_checkpoint_part_a where signature_url = any($1) order by completed_at limit 1", [probeFx.referenced]))[0];
    if (!partA) fail("no fixture movement references a real signature object");
    if (!(await q("select 1 from storage.objects where bucket_id = 'signatures' and name = $1", [partA.signature_url])).length) fail("the fixture signature object does not exist");
    fx.txId = partA.transaction_id;
    const sigName = partA.signature_url;
    const asoKul = idOf("aso-kul"), pend = idOf("neg-pending-profile"), rej = idOf("neg-rejected-profile"), deact = idOf("neg-deactivated-profile");
    const revoked = idOf("neg-revoked-assignment"), expired = idOf("neg-expired-assignment"), future = idOf("neg-future-assignment");
    const mgmt = idOf("caterlink_management"), ops = idOf("operation_manager"), driver = idOf("caterlink-driver"), vendor = idOf("caterlink-vendor");
    const asoPen = idOf("aso"), asoJhb = idOf("aso-jhb"), prof = idOf("profiling_aso");

    const snap = path.join(path.dirname(freshBackup), `ddlctzbnqewubltcavkh-profile-prechange-${Date.now()}.enc.json`);
    fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, helperDef: (await q(`select pg_get_functiondef('${HELPER}'::regprocedure) d`))[0].d, fingerprints: pre }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change helper definition snapshot written and re-authenticated (${path.basename(snap)})`);

    // ONE pass = apply + verify + real-role probes. Called once as a dry run (rolled back), then once for real.
    async function pass(real) {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [MIGRATION.version, MIGRATION.name, [sql]]);
        const hist = await q("select version from supabase_migrations.schema_migrations where version = $1", [MIGRATION.version]);
        if (hist.length !== 1) fail("history entry is not exactly one");
        if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT + 1) fail("unexpected history count");
        const def = (await q(`select pg_get_functiondef('${HELPER}'::regprocedure) d`))[0].d;
        for (const needle of ["p.status = 'approved'", "ura.aoc_id = p_aoc_id", "ura.station_id = p_destination_station_id", "ura.station_id = p_origin_station_id", "ura.revoked_at is null", "ura.starts_at <= now()", "ura.ends_at is null or ura.ends_at > now()", "ura.profile_id = auth.uid()"]) if (!def.includes(needle)) fail(`helper lost a required condition: ${needle}`);
        const meta = (await q(`select p.prosecdef d, p.provolatile v, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au from pg_proc p where p.oid = '${HELPER}'::regprocedure`))[0];
        if (!meta.d || meta.v !== "s" || !meta.c.some((x) => x === "search_path=public") || meta.an || !meta.au) fail("helper attributes/grants changed");

        await client.query("SAVEPOINT probes");
        const as = async (uid, role = "authenticated") => { await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : {}), role]); };
        const read = async (uid, role) => {
          await as(uid, role);
          const one = async (sql2, p) => { await client.query("SAVEPOINT r1"); try { const r = await client.query(sql2, p); await client.query("RELEASE SAVEPOINT r1"); return r.rowCount; } catch { await client.query("ROLLBACK TO SAVEPOINT r1"); return 0; } };
          const out = { tx: await one("select 1 from public.transactions where id = $1", [fx.txId]), seal: await one("select 1 from public.seals where transaction_id = $1", [fx.txId]), pa: await one("select 1 from public.caterlink_checkpoint_part_a where transaction_id = $1", [fx.txId]), sig: await one("select 1 from storage.objects where bucket_id = 'signatures' and name = $1", [sigName]) };
          await client.query("RESET ROLE");
          return out;
        };
        const all = (o) => o.tx && o.seal && o.pa && o.sig, none = (o) => !o.tx && !o.seal && !o.pa && !o.sig;
        const want = { [asoKul]: true, [mgmt]: true, [ops]: true, [driver]: true, [pend]: false, [rej]: false, [deact]: false, [revoked]: false, [expired]: false, [future]: false, [vendor]: false, [asoPen]: false, [asoJhb]: false, [prof]: false };
        for (const [uid, allowed] of Object.entries(want)) { const o = await read(uid); if (allowed ? !all(o) : !none(o)) fail(`probe: ${uid.slice(0, 8)} expected ${allowed ? "full access" : "no access"} but got ${JSON.stringify(o)}`); }
        const anon = await read(null, "anon"); if (!none(anon)) fail("probe: anon reads the movement");
        await client.query("ROLLBACK TO SAVEPOINT probes");

        const post = await fingerprints(client);
        for (const k of ["auth", "profiles", "assignments", "usersTable", "capabilities", "otherFunctions", "policies", "workflow", "transactionsFp", "storageObjects"]) if (post[k] !== pre[k]) fail(`unexpected change in ${k}`);
        const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
        if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
        log(`${real ? "APPLY" : "DRY RUN"}: verification PASSED (history once; helper keeps every station/AOC/date/revocation condition and adds approved-profile; attributes and grants unchanged; real-role probes: approved KUL officer, Management, Operation Manager and creating Driver read movement/seals/Part A/signature; pending, rejected, deactivated, revoked, expired, future, Vendor, PEN/JHB officers, Staff Profiling and anon read none; all other function bodies, policies, accounts, assignments, capabilities, workflow records and storage objects unchanged)`);
        if (!real) { await client.query("ROLLBACK"); log("DRY RUN: rolled back, no change made"); return; }
        await client.query("COMMIT");
        committed = true;
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); log(`${real ? "APPLY" : "DRY RUN"} ROLLED BACK: ${redact(e.message)}`); throw e; }
    }
    await pass(false);
    const afterDry = (await q("select version from supabase_migrations.schema_migrations order by version")).length;
    if (afterDry !== PRE_COUNT || (await q(`select md5(pg_get_functiondef('${HELPER}'::regprocedure)) h`))[0].h !== PRE_HELPER_MD5) fail("the dry run left a change behind");
    log("dry run left staging exactly as before (history count and helper definition re-checked)");
    if (DRY_ONLY) return;
    const t0 = Date.now();
    await pass(true);
    log(`COMMIT done in ${Date.now() - t0} ms`);
    const m2 = await q("select version from supabase_migrations.schema_migrations order by version");
    log(`post-commit: migrations=${m2.length} last=${m2[m2.length - 1].version}; ${MIGRATION.version} x${m2.filter((r) => r.version === MIGRATION.version).length}`);
    if (m2.length !== PRE_COUNT + 1 || m2.filter((r) => r.version === MIGRATION.version).length !== 1) fail("post-commit history check failed");
  } finally {
    await client.end();
    log(`log file: ${logPath}`);
  }
  if (committed) log("RESULT: SUCCESS");
}

main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
