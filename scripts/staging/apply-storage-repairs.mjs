#!/usr/bin/env node
// Applies ONLY the two storage-security repairs to the approved staging project, in order, in ONE transaction:
//   1. 20261026000001_storage_upload_policy_repair.sql   (authenticated uploads work again, without exposing get_report_submitter)
//   2. 20261026000002_signature_read_scoping.sql         (signature reads/lists scoped to uploader or authorised record)
// Because both run inside a single transaction, staging can never be left with working uploads and globally readable
// signatures: any failed check rolls BOTH back. Behavioural probes (real Driver / Vendor / anon roles) run inside the
// transaction BEFORE commit, then are rolled back to a savepoint. Prints names/counts only.
//
// Gates: exact repo/branch/origin, clean tree, HEAD descends from the authorized base; approved staging ref only and the
// production ref absent; verified TLS; original + fresh encrypted backups authenticate; history is exactly 65 migrations
// ending 20261025000001; migration files match the frozen SHA-256 hashes; storage.objects policy pre-state is exact.
//
// Usage: node --env-file=.env.local scripts/staging/apply-storage-repairs.mjs --expected-base=<sha> --backup=<path> [--preflight-only]
//   --preflight-only runs EVERYTHING (including the in-transaction verification) and then ROLLS BACK: nothing is changed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const PREFLIGHT_ONLY = args.includes("--preflight-only");
const expectedBase = argVal("expected-base");
const freshBackup = argVal("backup");

const MIGRATIONS = [
  { version: "20261026000001", name: "storage_upload_policy_repair", sha256: "8d241df18648625478f60b38156c5bf651fcbbff9135a96b87cbe8770dc5d093" },
  { version: "20261026000002", name: "signature_read_scoping", sha256: "68d0b69a1cd80b7d7bb9e689475d525a8ce8564914f75b3c5fe2810a652d31a6" },
];
const PRE_COUNT = 65;
const LAST_PRE = "20261025000001";
const EXPECTED_POLICIES = [
  "completed forms: authenticated read", "completed forms: authenticated upload", "incident photos: authenticated read", "incident photos: authenticated upload",
  "report attachments object insert", "report attachments object select", "sat combined report object select", "signatures: authenticated read", "signatures: authenticated upload",
];

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `storage-repairs-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function fingerprints(client) {
  const f = async (s) => (await client.query(s)).rows[0].v;
  return {
    auth: await f("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) v from auth.users u"),
    profiles: await f("select md5(string_agg(md5(p::text), ',' order by p.id::text)) v from public.profiles p"),
    assignments: await f("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') v from public.user_role_assignments a"),
    usersTable: await f("select coalesce(md5(string_agg(md5(u::text), ',' order by u.id::text)), 'none') v from public.users u"),
    capabilities: await f("select md5(string_agg(md5(c::text), ',' order by c.id::text)) v from public.caterlink_station_capabilities c"),
    scanFn: await f("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) v"),
    receiptFn: await f("select md5(pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure)) v"),
    txPolicy: await f("select md5(string_agg(policyname || coalesce(qual,''), ',' order by policyname)) v from pg_policies where schemaname='public' and tablename in ('transactions','caterlink_vendor_deliveries','caterlink_vendor_checkpoints')"),
    objects: await f("select count(*)::text v from storage.objects"),
  };
}

async function main() {
  if (!expectedBase || !freshBackup) fail("--expected-base and --backup are required");
  log(`storage repairs: ${PREFLIGHT_ONLY ? "PREFLIGHT (full dry run, rolled back)" : "APPLY"} starting`);
  const git = gitGates({ expectedBase, expectedRepoPath: path.resolve(import.meta.dirname, "../.."), extraAllowed: [/^supabase\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/] });
  log(`HEAD=${git.head} base=${expectedBase.slice(0, 12)}`);
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (path.relative(git.root, path.resolve(freshBackup)).startsWith("..") === false) fail("Fresh backup is inside the repository");
  if ((nb.authUsers?.length ?? 0) !== 56) fail(`Fresh backup lists ${nb.authUsers?.length} Auth users, expected 56`);
  log(`backups authenticate: original x${backups.length}; fresh backup exportedAt=${nb.exportedAt} authUsers=${nb.authUsers.length}`);

  const sqls = MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    return { ...m, sql: buf.toString("utf8") };
  });
  log(`migration files match the frozen hashes: ${sqls.map((m) => `${m.version}=${m.sha256.slice(0, 12)}`).join(" ")}`);

  const manifest = loadCurrentManifest();
  const idOf = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
  const driverId = idOf("caterlink-driver"), vendorId = idOf("caterlink-vendor"), asoId = idOf("aso"), mgmtId = idOf("caterlink_management");

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  let committed = false;
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`History is not exactly ${PRE_COUNT} ending ${LAST_PRE}`);
    if (mig.some((m) => MIGRATIONS.some((x) => x.version === m.version))) fail("A storage repair is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference in migration history");

    const pol = (await q("select policyname from pg_policies where schemaname='storage' and tablename='objects' order by 1")).map((r) => r.policyname);
    if (JSON.stringify(pol) !== JSON.stringify([...EXPECTED_POLICIES].sort())) fail(`storage.objects policy pre-state differs: ${pol.join(" | ")}`);
    if ((await q("select has_function_privilege('authenticated','public.get_report_submitter(text,uuid)','execute') a"))[0].a) fail("authenticated can already execute get_report_submitter");
    if ((await q("select to_regprocedure('public.can_upload_report_attachment(text)') r"))[0].r) fail("repair 1 function already exists");
    const pre = await fingerprints(client);
    if (pre.objects !== "0") fail(`storage.objects holds ${pre.objects} rows; the reviewed effect assumed an empty bucket set`);
    log("pre-state verified: 65 migrations, exact storage.objects policy set, get_report_submitter not executable by authenticated, 0 storage objects");

    const acl = await q("select p.oid::regprocedure::text sig, coalesce(p.proacl::text,'') acl from pg_proc p where p.proname in ('get_report_submitter')");
    const snap = path.join(path.dirname(freshBackup), `ddlctzbnqewubltcavkh-storage-prechange-${Date.now()}.enc.json`);
    const policyDefs = await q("select policyname, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='storage' and tablename='objects' order by 1");
    fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, storagePolicies: policyDefs, acl, fingerprints: pre }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change storage policy snapshot written and re-authenticated (${path.basename(snap)})`);

    log("BEGIN isolated transaction (both repairs, in order)");
    const t0 = Date.now();
    await client.query("BEGIN");
    try {
      for (const m of sqls) {
        await client.query(m.sql);
        await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [m.version, m.name, [m.sql]]);
        log(`applied ${m.version}_${m.name} (inside the transaction)`);
        if (m.version === MIGRATIONS[0].version) {
          // verify repair 1 before continuing
          if (!(await q("select has_function_privilege('authenticated','public.can_upload_report_attachment(text)','execute') b, has_function_privilege('anon','public.can_upload_report_attachment(text)','execute') a, has_function_privilege('authenticated','public.get_report_submitter(text,uuid)','execute') g"))[0].b) fail("authenticated cannot execute the wrapper");
          const w = (await q("select has_function_privilege('anon','public.can_upload_report_attachment(text)','execute') a, has_function_privilege('authenticated','public.get_report_submitter(text,uuid)','execute') g, has_function_privilege('anon','public.get_report_submitter(text,uuid)','execute') ga, p.prosecdef d, coalesce(p.proconfig,'{}') c, pg_get_function_result(p.oid) r from pg_proc p where p.oid = 'public.can_upload_report_attachment(text)'::regprocedure"))[0];
          if (w.a || w.g || w.ga) fail("repair 1 widened function access");
          if (!w.d || !w.c.some((x) => x.startsWith("search_path=")) || w.r !== "boolean") fail("wrapper is not a pinned SECURITY DEFINER boolean function");
          log("repair 1 verified: wrapper is a pinned SECURITY DEFINER boolean; anon denied; get_report_submitter still not executable by authenticated or anon");
        }
      }

      // ---- verification inside the transaction, before COMMIT ----
      const total = (await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n;
      if (total !== PRE_COUNT + 2) fail(`Expected ${PRE_COUNT + 2} history rows`);
      const pol2 = (await q("select policyname from pg_policies where schemaname='storage' and tablename='objects' order by 1")).map((r) => r.policyname);
      if (pol2.includes("signatures: authenticated read")) fail("the blanket signature read policy is still present");
      if (!pol2.includes("signatures: scoped read") || !pol2.includes("report attachments object insert") || !pol2.includes("signatures: authenticated upload")) fail("expected policies missing after the repairs");
      const sel = (await q("select policyname, qual from pg_policies where schemaname='storage' and tablename='objects' and cmd='SELECT' and qual ilike '%signatures%'"));
      if (sel.length !== 1 || /auth\.role\(\)/.test(sel[0].qual) || !/caterlink_signature_visible/.test(sel[0].qual)) fail("the signatures SELECT policy is not the scoped one");
      const ins = (await q("select with_check from pg_policies where schemaname='storage' and tablename='objects' and policyname='report attachments object insert'"))[0].with_check;
      if (!/can_upload_report_attachment/.test(ins) || /get_report_submitter/.test(ins)) fail("the report insert policy does not use the wrapper");
      const vis = (await q("select p.prosecdef d, has_function_privilege('anon', p.oid, 'execute') a from pg_proc p where p.oid = 'public.caterlink_signature_visible(text)'::regprocedure"))[0];
      if (vis.d || vis.a) fail("caterlink_signature_visible must be SECURITY INVOKER and not executable by anon");
      const trg = (await q("select count(*)::int n from pg_trigger where tgname like 'trg_cl_sig_owner_%'"))[0].n;
      if (trg !== 6) fail(`Expected 6 signature-owner guards, found ${trg}`);
      const gp = (await q("select has_function_privilege('anon','public.caterlink_signature_owner_guard()','execute') a, has_function_privilege('authenticated','public.caterlink_signature_owner_guard()','execute') b"))[0];
      if (gp.a || gp.b) fail("the guard function is callable by clients");

      // behavioural probes with real roles, undone by a savepoint
      await client.query("SAVEPOINT probes");
      const as = async (uid, role = "authenticated") => { await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [JSON.stringify(uid ? { sub: uid, role } : {}), role]); };
      const reset = async () => { await client.query("RESET ROLE"); };
      const run = `gate-${Date.now()}`;
      const dObj = `e2e-gate/${run}-driver.png`;
      const attempt = async (sql, p) => { await client.query("SAVEPOINT a1"); try { const r = await client.query(sql, p); await client.query("RELEASE SAVEPOINT a1"); return { ok: true, rows: r.rowCount, data: r.rows }; } catch (e) { await client.query("ROLLBACK TO SAVEPOINT a1"); return { ok: false, err: e.message }; } };
      await as(driverId);
      const up = await attempt("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [dObj, driverId]);
      if (!up.ok) fail(`probe: the Driver's upload is still refused: ${redact(up.err)}`);
      const own = await attempt("select name from storage.objects where bucket_id = 'signatures'");
      if (!own.ok || own.rows !== 1) fail(`probe: the uploader should read exactly its own object (${own.ok ? own.rows : own.err})`);
      const upd = await attempt("update storage.objects set name = name || '.x' where bucket_id = 'signatures'");
      const del = await attempt("delete from storage.objects where bucket_id = 'signatures'");
      if ((upd.ok && upd.rows) || (del.ok && del.rows)) fail("probe: UPDATE or DELETE changed an object");
      await reset(); await as(vendorId);
      const vList = await attempt("select name from storage.objects where bucket_id = 'signatures'");
      const vGet = await attempt("select 1 from storage.objects where bucket_id = 'signatures' and name = $1", [dObj]);
      if (!vList.ok || vList.rows !== 0 || !vGet.ok || vGet.rows !== 0) fail("probe: the Vendor can list or fetch the Driver's object");
      await reset(); await as(asoId);
      const aList = await attempt("select name from storage.objects where bucket_id = 'signatures'");
      if (!aList.ok || aList.rows !== 0) fail("probe: an unrelated officer can list a signature");
      await reset(); await as(mgmtId);
      const mList = await attempt("select name from storage.objects where bucket_id = 'signatures'");
      if (!mList.ok || mList.rows !== 0) fail("probe: Management can list an unreferenced signature");
      await reset(); await as(null, "anon");
      const anon = await attempt("select name from storage.objects where bucket_id = 'signatures'");
      if (anon.ok && anon.rows !== 0) fail("probe: anon can read a signature");
      const anonIns = await attempt("insert into storage.objects (bucket_id, name) values ('signatures', 'e2e-gate/anon.png')");
      if (anonIns.ok) fail("probe: anon can upload");
      await reset();
      await client.query("ROLLBACK TO SAVEPOINT probes");
      log("in-transaction probes PASSED and were rolled back (Driver upload ok and own-read only; update/delete change nothing; Vendor, unrelated officer, Management (unreferenced) and anon read nothing; anon cannot upload)");

      const post = await fingerprints(client);
      for (const k of ["auth", "profiles", "assignments", "usersTable", "capabilities", "scanFn", "receiptFn", "txPolicy", "objects"]) if (post[k] !== pre[k]) fail(`unexpected change in ${k}`);
      const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
      if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
      log("in-transaction verification PASSED (policies, wrapper, scoped read, guards, scan/receipt function bodies, transaction policies, Auth/profiles/assignments/users/capabilities all unchanged)");

      if (PREFLIGHT_ONLY) { await client.query("ROLLBACK"); log("PREFLIGHT ONLY: everything verified, then ROLLED BACK. No change made."); return; }
      await client.query("COMMIT");
      committed = true;
      log(`COMMIT done in ${Date.now() - t0} ms`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log(`ROLLED BACK (both repairs): ${redact(e.message)}`);
      throw e;
    }
    const m2 = await q("select version from supabase_migrations.schema_migrations order by version");
    log(`post-commit: migrations=${m2.length} last=${m2[m2.length - 1].version}`);
    if (m2.length !== PRE_COUNT + 2 || m2[m2.length - 1].version !== MIGRATIONS[1].version) fail("Post-commit history check failed");
  } finally {
    await client.end();
    log(`log file: ${logPath}`);
  }
  if (committed) log("RESULT: SUCCESS");
}

main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
