#!/usr/bin/env node
// Applies ONLY the eight frozen forward migrations 20261108000001..20261115000001 (see MIGRATIONS) to the approved staging project, as one unit.
// A complete transactional DRY RUN (apply, verify, behavioural probe, ROLLBACK) always comes first; only with --live and the exact phrase is
// the real application committed (migration + history row atomically). Prints names and counts only.
//
// Gates: exact repo / branch / origin, clean tree, HEAD == --expected-head; approved staging ref only and the production ref absent;
// verified TLS; existing encrypted backups AND the fresh backup (< 6 h, outside the repo, same Auth-user count) authenticate; hosted
// history is exactly 83 migrations ending 20261107000001; the migration matches its frozen SHA-256 (LF-normalised).
//
//   node --env-file=.env.local scripts/staging/apply-containment-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json>            (dry run)
//   node --env-file=.env.local scripts/staging/apply-containment-migration.mjs --expected-head=<sha> --backup=<fresh.enc.json> --live --confirm="<LIVE_PHRASE: APPLY <five versions joined with +> TO STAGING <approved ref>>"
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, APPROVED_REF, FORBIDDEN_REF } from "./lib/run-gates.mjs";

// Eight additive forward migrations applied as ONE guarded unit (each recorded in the history, all in one transaction).
export const MIGRATIONS = [
  { version: "20261108000001", name: "caterlink_fail_closed_containment", sha256: "ad8dbca5aed5ef4e9d7cbf0a23b1874ff3566707ca7345c3cd865b73c7089306" },
  { version: "20261109000001", name: "atomic_same_day_leave", sha256: "058b4afdcc7fe081cecc33e808088a241c0258b45eab75bb514c66f99e234671" },
  { version: "20261110000001", name: "registration_throttle", sha256: "3a2ea12506231afe272e4e04c803c6fd0b439a129b8268f532afe32490709369" },
  { version: "20261111000001", name: "vendor_check_signature_authorization", sha256: "7a130b188908e4cd73b75cabab7baef9efc9a6ec84664571ebb4b62c584fdc7e" },
  { version: "20261112000001", name: "block_unusable_driver_routes", sha256: "ae0ecb5ac2a2565385e542e56777c343fcf2684887717b955a75cec52b271ea2" },
  { version: "20261113000001", name: "signature_upload_authorization", sha256: "6ceb24360b2600060a466e8161c5ae15e78d1c78d939299af3f6b8a51f862499" },
  { version: "20261114000001", name: "incident_photos_lockdown", sha256: "7cdbdc27b712c03126d4eeef2b56692621967fc73965c79c0dae668601f75e95" },
  { version: "20261115000001", name: "signature_hardening", sha256: "397987ba9c8f9b6501eede0e1a3a156b0fff788c1a407efab1e2e4548efcd694" },
];
export const PRE_COUNT = 83;
export const LAST_PRE = "20261107000001";
export const LIVE_PHRASE = `APPLY ${MIGRATIONS.map((m) => m.version).join("+")} TO STAGING ${APPROVED_REF}`;
/** Every behavioural probe prints an explicit, sanitised PASS marker (a probe that fails aborts the run before this is reached). */
const probeLog = [];
const probe = (name) => { probeLog.push(name); log(`PROBE PASS: ${name}`); };
const SKIP = "public.skip_part_d(uuid, text)";
const RAISE = "public.raise_caterlink_incident_secure(uuid, text, text, text, text)";
const RECEIPT = "public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text)";
const LIST = "public.list_caterlink_pending_receipts_secure(text)";

/**
 * First top-level destructive statement (DROP TABLE / TRUNCATE / DELETE FROM) in a migration, or null. Comments and the bodies of
 * $function$ ... $function$ / $tag$ ... $tag$ blocks are ignored: a bounded clean-up statement inside a reviewed function is part of that
 * function, not something the migration itself executes.
 */
export function destructiveStatement(sql) {
  const code = String(sql)
    .replace(/--.*$/gm, "")
    .replace(/(\bdo\s+)?\$([A-Za-z_]*)\$[\s\S]*?\$\2\$/gi, (whole, isDo) => (isDo ? whole : "''")); // DO blocks run at migration time: keep them in view
  const m = /\b(drop\s+table|truncate|delete\s+from)\b/i.exec(code);
  return m ? m[0].toLowerCase() : null;
}

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

  const files = MIGRATIONS.map((m) => {
    const file = `${m.version}_${m.name}.sql`;
    const buf = fs.readFileSync(path.join(git.root, "supabase", "migrations", file));
    const sha = normalisedSha256(buf);
    if (sha !== m.sha256) fail(`${file}: SHA-256 ${sha} differs from the frozen ${m.sha256}`);
    const text = buf.toString("utf8");
    const destructive = destructiveStatement(text);
    if (destructive) fail(`${file} contains a destructive top-level statement: ${destructive}`);
    return { ...m, file, sql: text };
  });
  const migDir = fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  if (migDir.filter((f) => f.slice(0, 14) > LAST_PRE).join() !== files.map((f) => f.file).join()) fail("the repository holds a migration after the last applied one that is not in the frozen list");
  log(`${files.length} migrations match their frozen hashes and are the only ones after ${LAST_PRE}`);

  const manifest = loadCurrentManifest();
  const acct = (label) => manifest.find((a) => a.label === label)?.authUserId ?? fail(`manifest has no ${label}`);
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
    if ((await q("select to_regprocedure('public.caterlink_receipt_ready_statuses(text,text)') r"))[0].r) fail("the receipt state helper already exists on staging");

    const grants = async () => q(`select p.oid::regprocedure::text sig, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth,
      has_function_privilege('service_role', p.oid, 'execute') svc, exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') pub
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure') order by 1`);
    const before = await grants();
    for (const g of before) log(`BEFORE ${g.sig}: anon=${g.anon} authenticated=${g.auth} service_role=${g.svc} PUBLIC=${g.pub}`);
    const fp = async () => ({
      other: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname not in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure','caterlink_receipt_ready_statuses','caterlink_expected_receiving_station','submit_leave_application_secure','registration_throttle_hit','record_caterlink_vendor_security_check_secure','caterlink_vendor_check_upload_allowed','list_orphan_vendor_signatures_secure','enforce_completable_driver_route','caterlink_signature_upload_allowed','caterlink_part_b_upload_allowed','caterlink_receipt_upload_allowed','caterlink_vendor_complete_upload_allowed','caterlink_signature_owner_guard','caterlink_signature_referenced','list_orphan_signatures_secure','caterlink_incident_photo_visible') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
      profiles: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) h from public.profiles p"))[0].h,
      assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
      transactions: (await q("select coalesce(md5(string_agg(md5(t::text), ',' order by t.id::text)), 'none') h from public.transactions t"))[0].h,
      incidents: (await q("select count(*)::text h from public.caterlink_incidents"))[0].h,
      hub: (await q("select count(*)::text h from public.caterlink_checkpoint_hub"))[0].h,
      jobs: (await q("select count(*)::text h from public.caterlink_pdf_jobs"))[0].h,
      policies: (await q("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage') and tablename <> 'absence_notices' and not (schemaname = 'storage' and policyname in ('signatures: vendor check upload is delivery-bound','signatures: authenticated upload','signatures: workflow upload','incident photos: authenticated upload','incident photos: authenticated read','incident photos: scoped read'))"))[0].h,
      policiesAll: (await q("select md5(string_agg(schemaname || tablename || policyname || cmd || permissive || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage')"))[0].h,
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
        for (const f of files) {
          await client.query(f.sql);
          await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [f.version, f.name, [f.sql]]);
        }
        if ((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n !== PRE_COUNT + files.length) fail("unexpected history count");

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
        const rbody = (await q(`select pg_get_functiondef('${RECEIPT}'::regprocedure) d`))[0].d.toLowerCase();
        const lock = rbody.indexOf("for update"); const gate = rbody.indexOf("caterlink_receipt_ready_statuses"); const write = rbody.search(/insert into public\.caterlink_checkpoint_hub|update public\.transactions/);
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
          probe(`${label}: skip_part_d and raise_caterlink_incident_secure are denied`);
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
        // the receipt signature is the bound, existing, fresh object the destination officer would have uploaded (20261113000001)
        const rSig = `receipt/${tx}/${crypto.randomUUID()}.png`;
        await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [rSig, acct("aso-kch-receipt")]);
        const rcpt = async () => asUser("aso-kch-receipt", async () => { await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'KCH', '${rSig}', 'dry run')`, [tx]); return "ACCEPTED"; });
        const denied = await rcpt();
        if (!/not ready for receipt/i.test(denied)) fail(`a CREATED movement was not refused by the state gate (${denied})`);
        const leak = (await q("select (select count(*) from public.caterlink_checkpoint_hub where transaction_id = $1)::int + (select count(*) from public.caterlink_pdf_jobs where transaction_id = $1)::int + (select count(*) from public.phase8_audit_log where entity_id = $1)::int n", [tx]))[0].n;
        if (leak !== 0) fail("a refused receipt wrote a hub record, PDF job or audit row");
        probe("receipt: a CREATED movement is refused by the state gate and the refusal writes no hub record, PDF job or audit row");
        await client.query("update public.transactions set status = 'AIRPORT_POST_APPROVED' where id = $1", [tx]);
        const okRcpt = await asUser("aso-kch-receipt", async () => { const r = await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'KCH', '${rSig}', 'dry run')`, [tx]); return `ACCEPTED:${r.rows[0].status}`; });
        if (okRcpt !== "ACCEPTED:COMPLETED") fail(`the final-step state was not accepted (${okRcpt})`);
        probe("receipt: the destination officer completes a movement at its final-step state");

        // wrong-station receipt: an officer at BKI cannot receive a KCH movement (destination binding), rolled back
        {
          await client.query("SAVEPOINT bind");
          await client.query("update public.transactions set status = 'AIRPORT_POST_APPROVED' where id = $1", [tx]);
          const wrong = await asUser("aso-bki-receipt", async () => { await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'BKI', '${rSig}', 'dry run')`, [tx]); return "ACCEPTED"; });
          if (!/not available for receipt confirmation at this station/i.test(wrong)) fail(`a wrong-station receipt was not refused uniformly (${wrong})`);
          probe("wrong-station receipt: a BKI officer cannot receive a KCH movement that exists (uniform refusal, rolled back)");
          await client.query("ROLLBACK TO SAVEPOINT bind");
        }
        await client.query("ROLLBACK TO SAVEPOINT rc");
        // leave RPC and registration throttle: grants, policy, and a rolled-back behavioural probe
        const LEAVE = "public.submit_leave_application_secure(text, date, date, text)";
        const THROTTLE = "public.registration_throttle_hit(text, integer, integer)";
        const lg = (await q(`select has_function_privilege('anon', '${LEAVE}', 'execute') an, has_function_privilege('authenticated', '${LEAVE}', 'execute') au, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${LEAVE}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub`))[0];
        if (lg.an || lg.pub || !lg.au) fail("the leave RPC grants are not authenticated-only");
        const tg = (await q(`select has_function_privilege('anon', '${THROTTLE}', 'execute') an, has_function_privilege('authenticated', '${THROTTLE}', 'execute') au, has_function_privilege('service_role', '${THROTTLE}', 'execute') sv, has_table_privilege('authenticated', 'public.registration_throttle', 'select,insert,update,delete') tb`))[0];
        if (tg.an || tg.au || !tg.sv || tg.tb) fail("the registration throttle is not service-role only");
        const ins = (await q("select has_table_privilege('authenticated', 'public.absence_notices', 'insert') i, exists (select 1 from pg_policy where polrelid = 'public.absence_notices'::regclass and polname = 'absence_notices_insert_own') p"))[0];
        if (ins.i || ins.p) fail("a client can still insert absence notices directly");
        log("PROBE PASS: leave and registration throttle: grants are authenticated-only / service-role-only and the direct absence_notices insert path is closed"); probeLog.push("leave+throttle grants");
        {
          const probe = await asUser("aso", async () => { const r = await client.query("select * from public.submit_leave_application_secure('annual', current_date + 400, current_date + 401, 'dry run probe')"); return r.rows[0]?.result_same_day === false ? "OK" : "UNEXPECTED"; });
          if (probe !== "OK") fail(`the leave RPC probe failed (${probe})`);
          probeLog.push("atomic leave: a valid future leave is recorded atomically through the RPC"); log("PROBE PASS: atomic leave: a valid future leave is recorded atomically through the RPC (rolled back)");
          const denied = await asUser("neg-pending-profile", async () => { await client.query("select * from public.submit_leave_application_secure('absent', null, null, 'x')"); return "ALLOWED"; });
          if (/ALLOWED/.test(denied)) fail("a pending profile could submit leave");
          log("PROBE PASS: atomic leave: a pending profile cannot submit leave"); probeLog.push("atomic leave: pending profile denied");
        }

        // vendor Part B signature: delivery-bound Storage policy, orphan listing grants, and the Driver route guard
        {
          const pol = await q("select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'signatures: vendor check upload is delivery-bound' and not polpermissive");
          if (pol.length !== 1) fail("the restrictive vendor-signature Storage policy is missing");
          const og = (await q("select has_function_privilege('authenticated', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') au, has_function_privilege('anon', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') an, has_function_privilege('service_role', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') sv"))[0];
          if (og.au || og.an || !og.sv) fail("the orphan listing is not service-role only");
          const denied = await asUser("aso", async () => { await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [`vendor-part-b/${ghost}/${ghost.replace(/c01$/, "c02")}.png`, acct("aso")]); return "ALLOWED"; });
          if (/ALLOWED/.test(denied) || !/row-level security|policy/i.test(denied)) fail(`an unauthorised vendor-signature upload was not refused by Storage RLS (${denied})`);
          log("PROBE PASS: vendor Part B: an unauthorised upload for a non-existent delivery is refused by Storage RLS"); probeLog.push("vendor part b ghost denied");
          const trg = await q("select tgenabled from pg_trigger where tgname = 'trg_enforce_completable_driver_route' and tgrelid = 'public.transactions'::regclass");
          if (trg.length !== 1 || trg[0].tgenabled !== "O") fail("the Driver route guard trigger is missing or disabled");
          await client.query("SAVEPOINT rg");
          await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'service_role', true)", [JSON.stringify({ sub: acct("caterlink-driver"), role: "authenticated" })]);
          const routeDenied = await client.query(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, created_by)
            values ('ICMS-2026-990998', $1, 'OUTBOUND', 'UAT-VEH', '[GUARD-DRYRUN]', 'UAT-DRV', 'S', 'CREATED', 'AIRCRAFT', $2, $3)`, [aoc, pen, acct("caterlink-driver")]).then(() => "ALLOWED").catch((e) => String(e.message));
          await client.query("ROLLBACK TO SAVEPOINT rg");
          if (!/not available yet/i.test(routeDenied)) fail(`a Driver AIRCRAFT movement was not refused by the route guard (${routeDenied.slice(0, 80)})`);
          log("PROBE PASS: Driver route guard: an AIRCRAFT movement created by a Driver is refused by the database (rolled back)"); probeLog.push("route guard");
        }
        // signature bucket: the unrestricted upload policy is gone and every upload is authorised by the database (20261113000001)
        {
          const polRows = await q("select polname, polcmd, polpermissive, (select string_agg(rolname, ',') from pg_roles r where r.oid = any(polroles)) roles from pg_policy where polrelid = 'storage.objects'::regclass and (pg_get_expr(polwithcheck, polrelid) ilike '%signatures%' or pg_get_expr(polqual, polrelid) ilike '%signatures%') order by polname");
          if (polRows.some((p) => p.polname === "signatures: authenticated upload")) fail("the unrestricted signatures upload policy is still present");
          probe("the unrestricted 'signatures: authenticated upload' policy is absent after the migration");
          const permIns = polRows.filter((p) => p.polcmd === "a" && p.polpermissive);
          if (permIns.length !== 1 || permIns[0].polname !== "signatures: workflow upload" || permIns[0].roles !== "authenticated") fail(`the signatures INSERT policy set is not exactly one authenticated workflow policy (${JSON.stringify(permIns)})`);
          if (polRows.some((p) => ["w", "d", "*"].includes(p.polcmd))) fail("an UPDATE/DELETE/ALL policy exists for the signatures bucket");
          if (!polRows.some((p) => p.polname === "signatures: scoped read" && p.polcmd === "r")) fail("the scoped read policy is missing");
          probe("exactly one permissive INSERT policy (authenticated, 'signatures: workflow upload'), no UPDATE/DELETE policy, scoped read kept");
          if ((await q("select public from storage.buckets where id = 'signatures'"))[0].public !== false) fail("the signatures bucket is public");
          probe("the signatures bucket stays private");
          const fg = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au, has_function_privilege('service_role', p.oid, 'execute') sv,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') pub, p.prosecdef sd, coalesce(p.proconfig::text, '') cfg
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('caterlink_signature_upload_allowed','caterlink_part_b_upload_allowed','caterlink_receipt_upload_allowed','caterlink_vendor_complete_upload_allowed','caterlink_signature_referenced','list_orphan_signatures_secure') order by 1`);
          if (fg.length !== 6) fail(`expected six signature helpers, found ${fg.length}`);
          for (const f of fg) {
            const serviceOnly = /referenced|list_orphan/.test(f.proname);
            if (f.an || f.pub || !f.sv || !f.sd || !/search_path/.test(f.cfg) || (serviceOnly ? f.au : !f.au)) fail(`${f.proname} grants / definer / search_path are not as designed`);
          }
          probe("every signature helper is SECURITY DEFINER with a fixed search_path, denied to anon/PUBLIC; upload helpers callable by authenticated; reference check and orphan listing service-role only");

          const U = () => crypto.randomUUID();
          const accepted = async (who, name, owner = who) => asUser(who, async () => { await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [name, acct(owner)]); return "ACCEPTED"; });
          const expectDenied = (label, r) => { if (/ACCEPTED/.test(r) || !/row-level security|policy/i.test(r)) fail(`${label}: not refused by Storage RLS (${r})`); probe(label); };
          const expectAccepted = (label, r) => { if (r !== "ACCEPTED") fail(`${label}: not accepted (${r})`); probe(label); };
          const uidOf = acct;

          await client.query("SAVEPOINT sg");
          await client.query("set local session_replication_role = replica");
          const penTx = (await q(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
            values ('ICMS-2026-990997', $1, 'OUTBOUND', 'UAT-VEH', '[SIGNATURE-DRYRUN]', 'UAT-DRV', 'S', 'CREATED', 'AIRCRAFT', $2, 'AK9002', $3) returning id`, [aoc, pen, acct("caterlink-driver")]))[0].id;
          const doneTx = (await q(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
            values ('ICMS-2026-990996', $1, 'OUTBOUND', 'UAT-VEH', '[SIGNATURE-DRYRUN]', 'UAT-DRV', 'S', 'INFLIGHT_POST_APPROVED', 'AIRCRAFT', $2, 'AK9003', $3) returning id`, [aoc, pen, acct("caterlink-driver")]))[0].id;
          const kchTx = (await q(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, flight_number, created_by)
            values ('ICMS-2026-990995', $1, 'OUTBOUND', 'UAT-VEH', '[SIGNATURE-DRYRUN]', 'UAT-DRV', 'S', 'AIRPORT_POST_APPROVED', 'AIRCRAFT', $2, $3, 'AK9004', $4) returning id`, [aoc, pen, kch, acct("caterlink-driver")]))[0].id;
          const kchCreated = (await q(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, flight_number, created_by)
            values ('ICMS-2026-990994', $1, 'OUTBOUND', 'UAT-VEH', '[SIGNATURE-DRYRUN]', 'UAT-DRV', 'S', 'CREATED', 'AIRCRAFT', $2, $3, 'AK9005', $4) returning id`, [aoc, pen, kch, acct("caterlink-driver")]))[0].id;
          const delivery = async (status) => (await q(`insert into public.caterlink_vendor_deliveries (delivery_number, aoc_id, station_id, vendor_user_id, status, driver_name, driver_nric, vehicle_registration_no, seal_number)
            values ($1, $2, $3, $4, $5, '[SIGNATURE-DRYRUN]', 'X', 'UAT-VEH', 'S') returning id`, [`CLV-DRY-${U().slice(0, 8)}`, aoc, pen, acct("caterlink-vendor"), status]))[0].id;
          const dCreated = await delivery("CREATED");
          const dVerified = await delivery("SECURITY_VERIFIED");
          const dDone = await delivery("COMPLETED");
          await client.query("SAVEPOINT duty");
          const dutyOk = await client.query("insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, status) select $1, 'PEN', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'SG', now(), 'present' where exists (select 1 from public.stations where code = 'PEN')", [acct("aso")]).then((r) => r.rowCount === 1).catch(() => false);
          if (!dutyOk) await client.query("ROLLBACK TO SAVEPOINT duty");
          await client.query("set local session_replication_role = origin");

          // unknown prefixes and the arbitrary-path regression
          expectDenied("regression: an approved unrelated officer cannot upload signatures/arbitrary-test/<random>.png", await accepted("aso", `arbitrary-test/${U()}.png`));
          expectDenied("regression: a Driver cannot upload an unrecognised legacy-style path", await accepted("caterlink-driver", `part-a/${Date.now()}-abcd1234.png`));
          expectDenied("an unknown prefix is refused for a Vendor", await accepted("caterlink-vendor", `e2e-probe/vendor-${U()}.png`));
          expectDenied("an upper-case extension is refused", await accepted("caterlink-driver", `part-a/${uidOf("caterlink-driver")}/${U()}.PNG`));
          expectDenied("a path-traversal name is refused", await accepted("caterlink-driver", `part-a/${uidOf("caterlink-driver")}/../${U()}.png`));
          // Part A / vendor creation: the caller's own id only
          expectAccepted("a valid authorised prefix succeeds: an active Driver uploads part-a/<own uid>/<uuid>.png", await accepted("caterlink-driver", `part-a/${uidOf("caterlink-driver")}/${U()}.png`));
          expectDenied("cross-user: a Driver cannot upload under another account's id", await accepted("caterlink-driver", `part-a/${uidOf("aso")}/${U()}.png`));
          expectDenied("cross-user: an officer cannot upload a Driver's part-a path", await accepted("aso", `part-a/${uidOf("caterlink-driver")}/${U()}.png`));
          expectDenied("cross-user: an object owner that is not the caller is refused", await accepted("caterlink-driver", `part-a/${uidOf("caterlink-driver")}/${U()}.png`, "aso"));
          expectDenied("a Vendor cannot use the Driver prefix", await accepted("caterlink-vendor", `part-a/${uidOf("caterlink-vendor")}/${U()}.png`));
          expectAccepted("an active Vendor uploads vendor-signatures/<own uid>/<uuid>.png", await accepted("caterlink-vendor", `vendor-signatures/${uidOf("caterlink-vendor")}/${U()}.png`));
          expectDenied("cross-user: a Vendor cannot upload under a Driver's id", await accepted("caterlink-vendor", `vendor-signatures/${uidOf("caterlink-driver")}/${U()}.png`));
          // Part B: the officer's station, capability, duty and the movement's state
          if (dutyOk) expectAccepted("Part B: the PEN officer on duty uploads for a PEN movement waiting for Part B", await accepted("aso", `part-b/${penTx}-${U()}.png`));
          else fail("the Part B success precondition could not be set up: no usable duty check-in could be created for the PEN officer on staging");
          expectDenied("cross-station: a KUL officer cannot upload for a PEN movement", await accepted("aso-kul", `part-b/${penTx}-${U()}.png`));
          expectDenied("cross-station: a JHB officer (scan capability, other station) cannot upload for a PEN movement", await accepted("aso-jhb", `part-b/${penTx}-${U()}.png`));
          expectDenied("a pending profile is refused", await accepted("neg-pending-profile", `part-b/${penTx}-${U()}.png`));
          expectDenied("a rejected profile is refused", await accepted("neg-rejected-profile", `part-b/${penTx}-${U()}.png`));
          expectDenied("a deactivated profile is refused", await accepted("neg-deactivated-profile", `part-b/${penTx}-${U()}.png`));
          expectDenied("a revoked assignment is refused", await accepted("neg-revoked-assignment", `part-b/${penTx}-${U()}.png`));
          expectDenied("an expired assignment is refused", await accepted("neg-expired-assignment", `part-b/${penTx}-${U()}.png`));
          expectDenied("a future assignment is refused", await accepted("neg-future-assignment", `part-b/${penTx}-${U()}.png`));
          expectDenied("wrong workflow state: Part B upload for a movement already past Part B", await accepted("aso", `part-b/${doneTx}-${U()}.png`));
          expectDenied("missing parent: Part B upload for a non-existent movement", await accepted("aso", `part-b/${ghost}-${U()}.png`));
          expectDenied("a Driver cannot upload a Part B signature", await accepted("caterlink-driver", `part-b/${penTx}-${U()}.png`));
          // destination receipt
          expectAccepted("receipt: the KCH destination officer uploads for a KCH-bound movement at its receipt state", await accepted("aso-kch-receipt", `receipt/${kchTx}/${U()}.png`));
          expectDenied("receipt: a BKI officer cannot upload for a KCH-bound movement", await accepted("aso-bki-receipt", `receipt/${kchTx}/${U()}.png`));
          expectDenied("receipt: wrong workflow state (movement still CREATED)", await accepted("aso-kch-receipt", `receipt/${kchCreated}/${U()}.png`));
          expectDenied("receipt: missing parent", await accepted("aso-kch-receipt", `receipt/${ghost}/${U()}.png`));
          // vendor security check (Part B) and completion (Part C)
          expectAccepted("Vendor Part B success precondition: the authorised PEN officer uploads for a CREATED delivery", await accepted("aso", `vendor-part-b/${dCreated}/${U()}.png`));
          expectDenied("Vendor Part B denial: a KUL officer", await accepted("aso-kul", `vendor-part-b/${dCreated}/${U()}.png`));
          expectDenied("Vendor Part B denial: the owning Vendor", await accepted("caterlink-vendor", `vendor-part-b/${dCreated}/${U()}.png`));
          expectDenied("Vendor Part B denial: a delivery that is no longer CREATED", await accepted("aso", `vendor-part-b/${dVerified}/${U()}.png`));
          expectDenied("Vendor Part B denial: a non-existent delivery", await accepted("aso", `vendor-part-b/${ghost}/${U()}.png`));
          expectAccepted("Vendor Part C: the owning Vendor uploads for a security-verified delivery", await accepted("caterlink-vendor", `vendor-part-c/${dVerified}/${U()}.png`));
          expectDenied("Vendor Part C: an officer cannot upload", await accepted("aso", `vendor-part-c/${dVerified}/${U()}.png`));
          expectDenied("Vendor Part C: wrong workflow state (delivery still CREATED)", await accepted("caterlink-vendor", `vendor-part-c/${dCreated}/${U()}.png`));
          expectDenied("Vendor Part C: wrong workflow state (delivery already COMPLETED)", await accepted("caterlink-vendor", `vendor-part-c/${dDone}/${U()}.png`));
          // no overwrite / move / delete by a client
          {
            const name = `part-a/${uidOf("caterlink-driver")}/${U()}.png`;
            const r = await asUser("caterlink-driver", async () => {
              await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [name, acct("caterlink-driver")]);
              await client.query("SAVEPOINT ow");
              const dup = await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [name, acct("caterlink-driver")]).then(() => "ALLOWED").catch((e) => (/duplicate key|row-level security/i.test(String(e.message)) ? "REFUSED" : "OTHER:" + String(e.message).slice(0, 50)));
              await client.query("ROLLBACK TO SAVEPOINT ow");
              const upd = await client.query("update storage.objects set name = $1 where bucket_id = 'signatures' and name = $2", [`part-a/${uidOf("caterlink-driver")}/${U()}.png`, name]).then((x) => x.rowCount).catch(() => 0);
              const del = await client.query("delete from storage.objects where bucket_id = 'signatures' and name = $1", [name]).then((x) => x.rowCount).catch(() => 0);
              return `${dup}|${upd}|${del}`;
            });
            if (!/^REFUSED[|]0[|]0$/.test(r)) fail(`an overwrite, move or delete by a client was not refused (${r})`);
            probe("no overwrite, move or delete: a duplicate insert is refused and UPDATE/DELETE by the uploader affect no row");
          }
          // finalisation binds the stored reference
          {
            await client.query("SAVEPOINT fin");
            const unbound = await client.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'x','x','part-a/anything.png',$2)", [penTx, acct("caterlink-driver")]).then(() => "ALLOWED").catch((e) => String(e.message));
            await client.query("ROLLBACK TO SAVEPOINT fin");
            if (!/not the one uploaded for this record/i.test(unbound)) fail(`an unbound signature reference was accepted at finalisation (${unbound.slice(0, 80)})`);
            probe("finalisation: a checkpoint cannot reference a path that is not bound to its row and actor");
            await client.query("SAVEPOINT fin");
            const missing = await client.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'x','x',$2,$3)", [penTx, `part-a/${acct("caterlink-driver")}/${U()}.png`, acct("caterlink-driver")]).then(() => "ALLOWED").catch((e) => String(e.message));
            await client.query("ROLLBACK TO SAVEPOINT fin");
            if (!/was not uploaded by this account/i.test(missing)) fail(`a reference to a non-existent object was accepted at finalisation (${missing.slice(0, 80)})`);
            probe("finalisation: a checkpoint cannot reference an object that does not exist");
            const finTry = async (name, owner, ageSql) => {
              await client.query("SAVEPOINT fin2");
              await client.query(`insert into storage.objects (bucket_id, name, owner, created_at) values ('signatures', $1, $2, ${ageSql})`, [name, owner]);
              const r = await client.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'x','x',$2,$3)", [penTx, name, acct("caterlink-driver")]).then(() => "ACCEPTED").catch((e) => String(e.message));
              await client.query("ROLLBACK TO SAVEPOINT fin2");
              return r;
            };
            const foreign = await finTry(`part-a/${acct("caterlink-driver")}/${U()}.png`, acct("aso"), "now()");
            if (!/was not uploaded by this account/i.test(foreign)) fail(`an object owned by another account was accepted at finalisation (${foreign.slice(0, 80)})`);
            probe("finalisation: a checkpoint cannot reference an object owned by a different account");
            const stale = await finTry(`part-a/${acct("caterlink-driver")}/${U()}.png`, acct("caterlink-driver"), "now() - interval '2 hours'");
            if (!/was not uploaded by this account/i.test(stale)) fail(`a stale object (older than 20 minutes) was accepted at finalisation (${stale.slice(0, 80)})`);
            probe("finalisation: a checkpoint cannot adopt an object older than the 20-minute freshness limit");
            const good = await finTry(`part-a/${acct("caterlink-driver")}/${U()}.png`, acct("caterlink-driver"), "now()");
            if (good !== "ACCEPTED") fail(`the bound, fresh, own object was refused at finalisation (${good.slice(0, 80)})`);
            probe("finalisation: the caller's own bound, fresh, existing object is accepted");
          }
          const og2 = (await q("select has_function_privilege('authenticated', 'public.list_orphan_signatures_secure(integer, integer)', 'execute') au, has_function_privilege('service_role', 'public.list_orphan_signatures_secure(integer, integer)', 'execute') sv"))[0];
          if (og2.au || !og2.sv) fail("the signature orphan listing is not service-role only");
          probe("the trusted service role keeps the orphan listing and reference check; clients cannot call them");

          // ---- hardening (20261115000001): single-use objects, per-account quota, registry, paged listing, bucket limits
          {
            const drvUid = acct("caterlink-driver");
            await client.query("SAVEPOINT su");
            const objA = `part-a/${drvUid}/${U()}.png`;
            await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [objA, drvUid]);
            const first = await client.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'x','x',$2,$3)", [penTx, objA, drvUid]).then(() => "ACCEPTED").catch((e) => String(e.message));
            const second = await client.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'x','x',$2,$3)", [doneTx, objA, drvUid]).then(() => "ACCEPTED").catch((e) => String(e.message));
            await client.query("ROLLBACK TO SAVEPOINT su");
            if (first !== "ACCEPTED") fail(`the first reference to a fresh own object was refused (${first.slice(0, 80)})`);
            if (!/already been used/i.test(second)) fail(`a second reference to the same object was not refused as already used (${second.slice(0, 80)})`);
            probe("single use: an object backs ONE checkpoint row; a second row referencing it is refused");
            const reg = (await q("select has_table_privilege('authenticated', 'public.caterlink_signature_refs', 'select') s, has_table_privilege('anon', 'public.caterlink_signature_refs', 'select') a, has_table_privilege('authenticated', 'public.caterlink_signature_refs', 'insert') i, (select relrowsecurity from pg_class where oid = 'public.caterlink_signature_refs'::regclass) r"))[0];
            if (reg.s || reg.a || reg.i || !reg.r) fail("the single-use registry is reachable by a client");
            probe("the single-use registry has RLS on and no client grant");

            await client.query("SAVEPOINT quota");
            // same-account baseline first (asUser rolls its own insert back, so it leaves nothing behind), then 30 leftovers are written directly: only the 31st-state refusal can be the quota
            expectAccepted("quota baseline: the same account can upload while below the limit", await accepted("caterlink-driver", `part-a/${drvUid}/${U()}.png`));
            for (let k = 0; k < 30; k += 1) await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [`part-a/${drvUid}/${U()}.png`, drvUid]);
            expectDenied("quota: an account that already has 30 unreferenced signature objects in the hour is refused", await accepted("caterlink-driver", `part-a/${drvUid}/${U()}.png`));
            expectAccepted("quota: another account is unaffected", await accepted("caterlink-vendor", `vendor-signatures/${acct("caterlink-vendor")}/${U()}.png`));
            await client.query("ROLLBACK TO SAVEPOINT quota");

            const pg = (await q("select has_function_privilege('authenticated', 'public.list_orphan_signatures_secure(integer, integer)', 'execute') au, has_function_privilege('anon', 'public.list_orphan_signatures_secure(integer, integer)', 'execute') an, has_function_privilege('service_role', 'public.list_orphan_signatures_secure(integer, integer)', 'execute') sv, (select count(*)::int from pg_proc where proname = 'list_orphan_signatures_secure' and pronamespace = 'public'::regnamespace) n"))[0];
            if (pg.au || pg.an || !pg.sv || pg.n !== 1) fail("the paged orphan listing is not a single service-role-only function");
            probe("the paged orphan listing is a single service-role-only function");
            const lim = (await q("select file_size_limit, allowed_mime_types from storage.buckets where id = 'signatures'"))[0];
            if (Number(lim.file_size_limit) !== 5242880 || [...(lim.allowed_mime_types ?? [])].sort().join() !== "image/jpeg,image/png,image/webp") fail(`the signatures bucket limits are not 5 MB and image/png|jpeg|webp (${JSON.stringify(lim)})`);
            probe("the signatures bucket accepts at most 5 MB and image/png|jpeg|webp only");
          }

          // ---- incident-photos bucket (20261114000001): no client upload, reads follow the incident
          {
            const ip = await q("select polname, polcmd, polpermissive, (select string_agg(rolname, ',') from pg_roles r where r.oid = any(polroles)) roles from pg_policy where polrelid = 'storage.objects'::regclass and (pg_get_expr(polwithcheck, polrelid) ilike '%incident-photos%' or pg_get_expr(polqual, polrelid) ilike '%incident-photos%') order by polname");
            if (ip.some((x) => /authenticated (upload|read)$/.test(x.polname))) fail("a historical unrestricted incident-photos policy is still present");
            if (ip.some((x) => x.polcmd === "a" || x.polcmd === "w" || x.polcmd === "d" || x.polcmd === "*")) fail("a client write policy exists for the incident-photos bucket");
            if (ip.length !== 1 || ip[0].polname !== "incident photos: scoped read" || ip[0].polcmd !== "r" || ip[0].roles !== "authenticated") fail(`the incident-photos policy set is not exactly the scoped read (${JSON.stringify(ip)})`);
            probe("incident-photos: both unrestricted policies are gone; only the scoped SELECT for authenticated remains and no client write policy exists");
            const incPhoto = `incident-photos/${U()}/${U()}.png`;
            const lone = `incident-photos/${U()}/${U()}.png`;
            const asIp = async (who, name, owner = who) => asUser(who, async () => { await client.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2)", [name, acct(owner)]); return "ACCEPTED"; });
            for (const who of ["aso", "aso-kul", "caterlink-driver", "caterlink-vendor", "caterlink_management"]) {
              expectDenied(`incident-photos: ${who} cannot upload (no client upload workflow exists)`, await asIp(who, `incident-photos/${U()}/${U()}.png`));
            }
            await client.query("set local session_replication_role = replica");
            await client.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2)", [incPhoto, acct("aso-kul")]);
            await client.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2)", [lone, acct("aso")]);
            await client.query(`insert into public.caterlink_incidents (transaction_id, aoc_id, station_id, incident_type, severity, description, reported_by, status, photo_url)
              values ($1,$2,$3,'OTHER','low','[INCIDENT-PHOTO-DRYRUN]',$4,'OPEN',$5)`, [penTx, aoc, pen, acct("aso-kul"), incPhoto]);
            await client.query("set local session_replication_role = origin");
            const readObj = async (who, name) => asUser(who, async () => (await client.query("select count(*)::int n from storage.objects where bucket_id = 'incident-photos' and name = $1", [name])).rows[0].n === 1 ? "READ" : "HIDDEN");
            const exp = async (label, who, name, want) => { const r = await readObj(who, name); if (r !== want) fail(`incident-photos read: ${label} expected ${want}, got ${r}`); probe(`incident-photos read: ${label} -> ${want}`); };
            await exp("the reporter can read the photo of their incident", "aso-kul", incPhoto, "READ");
            await exp("CaterLink Management of the AOC can read it (visible incident)", "caterlink_management", incPhoto, "READ");
            await exp("an unrelated PEN officer cannot read it", "aso", incPhoto, "HIDDEN");
            await exp("a JHB officer cannot read it", "aso-jhb", incPhoto, "HIDDEN");
            await exp("a Driver cannot read it", "caterlink-driver", incPhoto, "HIDDEN");
            await exp("a Vendor cannot read it", "caterlink-vendor", incPhoto, "HIDDEN");
            await exp("an unreferenced object is readable by its uploader", "aso", lone, "READ");
            await exp("and not by anyone else (Management)", "caterlink_management", lone, "HIDDEN");
          }

          // ---- structure: no permissive write policy on storage.objects lacks a bucket restriction (catches hosted-only policies that never mention 'signatures')
          {
            const writes = await q("select polname, polcmd, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) w from pg_policy where polrelid = 'storage.objects'::regclass and polpermissive and polcmd in ('a','w','d','*') order by polname");
            // a policy is "scoped" only if it names a bucket AND carries no escape hatch (`or true`, an always-true branch)
            const isScoped = (x) => { const t = `${x.q ?? ""} ${x.w ?? ""}`; return /bucket_id\s*=\s*'/.test(t) && !/\bor\s+(true|1\s*=\s*1)\b|\(\s*true\s*\)/i.test(t); };
            const unscoped = writes.filter((x) => !isScoped(x));
            if (unscoped.length > 0) fail(`permissive write policies on storage.objects without a bucket restriction: ${unscoped.map((x) => x.polname).join(", ")}`);
            log(`write policies on storage.objects after the migrations (all bucket-scoped): ${writes.map((x) => x.polname).join(" | ")}`);
            probe("structure: every permissive INSERT/UPDATE/DELETE/ALL policy on storage.objects names a bucket and has no always-true branch (no unscoped hosted-only write policy)");
            // READ side: an unscoped permissive SELECT policy would make both buckets listable even though neither is named in it
            const reads = await q("select polname, pg_get_expr(polqual, polrelid) q from pg_policy where polrelid = 'storage.objects'::regclass and polpermissive and polcmd in ('r','*') order by polname");
            const unscopedReads = reads.filter((x) => !isScoped({ q: x.q, w: "" }));
            if (unscopedReads.length > 0) fail(`permissive SELECT policies on storage.objects without a bucket restriction: ${unscopedReads.map((x) => x.polname).join(", ")}`);
            log(`read policies on storage.objects after the migrations (all bucket-scoped): ${reads.map((x) => x.polname).join(" | ")}`);
            probe("structure: every permissive SELECT policy on storage.objects names a bucket and has no always-true branch (neither bucket can be listed through an unscoped read policy)");
            // behavioural proof of the same thing: an unreferenced object of another account is invisible to an unrelated officer in BOTH buckets
            await client.query("set local session_replication_role = replica");
            const hiddenSig = `part-a/${acct("caterlink-driver")}/${U()}.png`;
            await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [hiddenSig, acct("caterlink-driver")]);
            await client.query("set local session_replication_role = origin");
            const seen = await asUser("aso-jhb", async () => (await client.query("select count(*)::int n from storage.objects where bucket_id in ('signatures','incident-photos') and name = $1", [hiddenSig])).rows[0].n);
            if (seen !== 0) fail("an unrelated officer can read another account's unreferenced signature object");
            probe("structure (behavioural): an unrelated officer cannot read or list another account's unreferenced signature object");
            const touching = writes.filter((x) => /signatures|incident-photos/.test(`${x.q ?? ""} ${x.w ?? ""}`)).map((x) => x.polname);
            if (touching.join() !== "signatures: workflow upload") fail(`unexpected write policies reach the signatures or incident-photos buckets: ${touching.join(", ")}`);
            probe("structure: the only permissive write policy that reaches either bucket is 'signatures: workflow upload'");
          }
          await client.query("ROLLBACK TO SAVEPOINT sg");
        }

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
    if ((await fp()).policiesAll !== pre.policiesAll) fail("the dry run left a policy change behind (the original storage/public policies are not exactly as before)");
    if ((await q("select count(*)::int n from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'signatures: authenticated upload'"))[0].n !== 1) fail("the original signatures upload policy was not restored by the rollback");
    log("PROBE PASS: after rollback every original public/storage policy is exactly as before (the legacy upload policy is still present, nothing was committed)");
    const afterDry = await grants();
    if (JSON.stringify(afterDry) !== JSON.stringify(before)) fail("the dry run changed a grant");
    log("dry run left staging exactly as before (history count, helper absence, grants and policies re-checked)");
    log(`SUMMARY: ${probeLog.length} probe PASS markers printed (see PROBE PASS lines above)`);
    if (!LIVE) return;
    await pass(true);
    if ((await q("select 1 from supabase_migrations.schema_migrations where version = any($1)", [MIGRATIONS.map((m) => m.version)])).length !== MIGRATIONS.length) fail("post-commit history check failed");
    log(`APPLIED ${MIGRATIONS.map((m) => m.version).join(", ")} (committed, each recorded once)`);
    log("RESULT: SUCCESS");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
