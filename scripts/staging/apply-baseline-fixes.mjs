#!/usr/bin/env node
// Applies ONLY the two reviewed baseline-fix migrations to the approved staging project, in order:
//   20261106000001_report_index_queue_service_context  (report index worker runs in the service-role context)
//   20261106000002_shift_handovers_canonical_policies  (canonical, role-scoped shift_handovers policies)
// A complete transactional DRY RUN (apply, verify, behavioural probe with a rolled-back synthetic report, ROLLBACK) comes first, then --
// only with --live and the exact phrase -- the real application, with each migration and its history row committed atomically.
// Prints names and counts only.
//
// Gates: exact repo / branch / origin, clean tree, HEAD == --expected-head; approved staging ref only and the production ref absent;
// verified TLS; existing encrypted backups authenticate AND the fresh backup (< 6 h, outside the repo, same Auth-user count) authenticates;
// hosted history is exactly 80 migrations ending 20261105000001; every migration matches its frozen SHA-256; the hosted function is exactly
// the expected pre-state.
//
//   node --env-file=.env.local scripts/staging/apply-baseline-fixes.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-baseline-fixes.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="APPLY 20261106000001+20261106000002 TO STAGING ddlctzbnqewubltcavkh"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

export const MIGRATIONS = [
  { version: "20261106000001", name: "report_index_queue_service_context", sha256: "95423a162c45245784590ef26fbcc6d8117d8ad26f0a1a29db3d5bea1b341ede" },
  { version: "20261106000002", name: "shift_handovers_canonical_policies", sha256: "7ccfccb4edd909579eac051be1f5214ba0c1f488b33d853f4fab23f665302e0e" },
];
export const PRE_COUNT = 80;
export const LAST_PRE = "20261105000001";
export const LIVE_PHRASE = `APPLY ${MIGRATIONS.map((m) => m.version).join("+")} TO STAGING ${APPROVED_REF}`;
const FN = "public.process_report_index_queue(integer)";

export const normalisedSha256 = (buf) => crypto.createHash("sha256").update(buf.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const LIVE = args.includes("--live");
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");
const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, `baseline-fixes-${process.pid}.log`), l + "\n"); };

async function main() {
  const expectedHead = argVal("expected-head");
  const freshBackup = argVal("backup");
  if (!expectedHead || !freshBackup) fail("--expected-head and --backup are required");
  if (LIVE && argVal("confirm") !== LIVE_PHRASE) fail("the live phase needs the exact confirmation phrase");
  log(`baseline fixes: ${LIVE ? "dry run, then LIVE APPLY" : "DRY RUN only"}`);

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

  const files = MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    return { ...m, sql: buf.toString("utf8") };
  });
  const onDisk = fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort().filter((f) => f.slice(0, 14) > LAST_PRE);
  if (JSON.stringify(onDisk) !== JSON.stringify(MIGRATIONS.map((m) => `${m.version}_${m.name}.sql`))) fail("the repository holds a migration after the last applied one that is not in the frozen list");
  const code = (t) => t.replace(/--.*$/gm, "");
  const defs = [...code(files[0].sql).matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1]);
  if (defs.length !== 1 || defs[0] !== "process_report_index_queue" || /create policy|drop policy|alter table|drop /i.test(code(files[0].sql))) fail("migration 1 changes more than the one worker function (and the queue repair)");
  if (/create (or replace )?function|alter table|drop table|grant |revoke /i.test(code(files[1].sql)) || [...code(files[1].sql).matchAll(/(?:create|drop) policy (?:if exists )?"([^"]+)"/gi)].some((m) => !m[1].startsWith("shift_handovers "))) fail("migration 2 changes more than the three shift_handovers policies");
  log(`${files.length} migrations match their frozen hashes; migration 1 replaces only process_report_index_queue(), migration 2 only the three shift_handovers policies`);

  const manifest = loadCurrentManifest();
  const submitter = manifest.find((a) => a.label === "aso-kul")?.authUserId ?? fail("manifest has no aso-kul");
  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  try {
    const q = async (s, p) => (await client.query(s, p)).rows;
    const mig = await q("select version, name from supabase_migrations.schema_migrations order by version");
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`history is not exactly ${PRE_COUNT} ending ${LAST_PRE}`);
    if (mig.some((m) => MIGRATIONS.some((x) => x.version === m.version))) fail("a frozen migration is already recorded");
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("production reference in migration history");
    if ((await q("select count(*)::int n from auth.users"))[0].n !== nb.authUsers?.length) fail("fresh backup Auth-user count differs from the live database");
    const preDef = (await q(`select pg_get_functiondef('${FN}'::regprocedure) d`))[0].d;
    if (preDef.includes("set_config('request.jwt.claims'")) fail("the hosted worker already sets the service-role context");
    const fp = async () => ({
      def: (await q(`select md5(pg_get_functiondef('${FN}'::regprocedure)) h`))[0].h,
      other: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.oid <> '${FN}'::regprocedure and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
      profiles: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) h from public.profiles p"))[0].h,
      reports: (await q("select (select count(*) from public.report_sec016)::text || '/' || (select count(*) from public.central_reports_index)::text h"))[0].h,
      policies: (await q("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage') and tablename <> 'shift_handovers'"))[0].h,
      handoverGrants: (await q("select md5(string_agg(grantee || privilege_type, ',' order by grantee, privilege_type)) h from information_schema.role_table_grants where table_schema='public' and table_name='shift_handovers'"))[0].h,
      handoverRows: (await q("select count(*)::text h from public.shift_handovers"))[0].h,
    });
    const pre = await fp();
    const snap = path.join(path.dirname(freshBackup), `${APPROVED_REF}-queue-fn-prechange-${Date.now()}.enc.json`);
    fs.writeFileSync(snap, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), functionDef: preDef, fingerprints: pre }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snap, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change function definition snapshot written and re-authenticated (${path.basename(snap)})`);

    async function pass(real) {
      await client.query("BEGIN");
      try {
        for (const f of files) {
          await client.query(f.sql);
          await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
        }
        if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT + files.length) fail("unexpected history count");
        const def = (await q(`select pg_get_functiondef('${FN}'::regprocedure) d`))[0].d;
        if (!def.includes("set_config('request.jwt.claims'") || !/SECURITY DEFINER/.test(def)) fail("the new function body is not as expected");
        const meta = (await q(`select has_function_privilege('anon', '${FN}'::regprocedure, 'execute') an, has_function_privilege('authenticated', '${FN}'::regprocedure, 'execute') au, has_function_privilege('service_role', '${FN}'::regprocedure, 'execute') sv, coalesce(p.proconfig,'{}') c from pg_proc p where p.oid = '${FN}'::regprocedure`))[0];
        if (meta.an || meta.au || !meta.sv || !meta.c.some((x) => x === "search_path=public")) fail("function grants or search_path changed");
        // behavioural probe (rolled back with everything else): a synthetic report from the real submit path is indexed from the cron context
        await client.query("SAVEPOINT probe");
        const prof = (await q("select id, station, team, name, staff_no from public.profiles where id = $1", [submitter]))[0];
        await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: prof.id, role: "authenticated" })]);
        const r = (await q(
          `insert into public.report_sec016 (profile_id, status, submitted_at, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, inbound_baggage, outbound_baggage, inbound_cargo, outbound_cargo, inbound_co_mail, outbound_co_mail, shift_leader, ramp_staff_1, ramp_staff_2, ramp_staff_3, ramp_staff_4, ramp_staff_5, cargo_hold_checked, staff_frisked, discrepancies, offload_flight_no, offload_destination, offload_baggage_tag_no, offload_total_baggage, offload_remark)
           values ($1,'submitted',now(),$2,$3,$4,$5,current_date,'10:00','AK9888','ARR/KUL','x','A320','9M-PROBE','10:00','10:15','B1','NO','0','0','0','0','0','0','x','x','x','x','x','x','NO','NO','ROLLED BACK PROBE','N/A','N/A','N/A','0','x') returning id`,
          [prof.id, prof.station, prof.team, prof.name, prof.staff_no],
        ))[0];
        await client.query("select public.mark_report_ready_for_indexing('report_sec016', $1, 0)", [r.id]);
        await client.query("reset role");
        await client.query("select set_config('request.jwt.claims', '', true)");
        const run = (await q("select * from public.process_report_index_queue(50)"))[0];
        const idx = (await q("select operating_entity_code from public.central_reports_index where source_id = $1", [r.id]))[0];
        if (run.permanently_failed !== 0 || idx?.operating_entity_code !== "MAA") fail(`probe: the worker did not index the report from the cron context (${JSON.stringify(run)}, ${idx?.operating_entity_code})`);
        await client.query("ROLLBACK TO SAVEPOINT probe");
        const post = await fp();
        if (post.other !== pre.other || post.profiles !== pre.profiles || post.reports !== pre.reports || post.policies !== pre.policies || post.handoverGrants !== pre.handoverGrants || post.handoverRows !== pre.handoverRows) fail("an unrelated function, policy, grant, profile, report or handover row changed");
        // shift_handovers policies: canonical, role-scoped, none for PUBLIC, no legacy rank
        const pol = await q("select policyname, roles::text r, coalesce(qual,'') || coalesce(with_check,'') x from pg_policies where schemaname = 'public' and tablename = 'shift_handovers'");
        if (pol.length !== 3 || pol.some((x) => x.r !== "{authenticated}" || /current_role_rank|role_rank|is_monitor_or_above/.test(x.x))) fail("shift_handovers policies are not the canonical, authenticated-only set");
        for (const label of ["aso-kul", "aso-jhb"]) {
          await client.query("SAVEPOINT hp");
          await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: manifest.find((a) => a.label === label).authUserId, role: "authenticated" })]);
          await q("select count(*) from public.shift_handovers");
          await client.query("reset role");
          await client.query("ROLLBACK TO SAVEPOINT hp");
        }
        await client.query("SAVEPOINT an");
        const anonRead = await client.query("set local role anon").then(() => client.query("select count(*) from public.shift_handovers")).then(() => "read").catch(() => "denied");
        await client.query("ROLLBACK TO SAVEPOINT an");
        if (anonRead !== "denied") fail("anon can read shift_handovers");
        log(`${real ? "APPLY" : "DRY RUN"}: verification PASSED (history once; only the worker body changed; grants and search_path unchanged; a synthetic AK report is indexed as MAA from the no-JWT cron context; probe rolled back; no other function, policy, profile or report changed)`);
        if (!real) { await client.query("ROLLBACK"); log("DRY RUN: rolled back, no change made"); return; }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); log(`${real ? "APPLY" : "DRY RUN"} ROLLED BACK: ${redact(e.message)}`); throw e; }
    }
    await pass(false);
    const afterDry = await fp();
    if (afterDry.def !== pre.def || (await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT) fail("the dry run left a change behind");
    log("dry run left staging exactly as before (history count and function definition re-checked)");
    if (!LIVE) return;
    await pass(true);
    const m2 = await q("select version from supabase_migrations.schema_migrations where version = any($1)", [MIGRATIONS.map((m) => m.version)]);
    if (m2.length !== MIGRATIONS.length) fail("post-commit history check failed");
    log(`APPLIED ${MIGRATIONS.map((m) => m.version).join(", ")} (committed, each recorded once)`);
    log("RESULT: SUCCESS");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
