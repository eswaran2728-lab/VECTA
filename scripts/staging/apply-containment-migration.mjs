#!/usr/bin/env node
// Applies ONLY the five frozen forward migrations 20261108000001..20261112000001 (see MIGRATIONS) to the approved staging project, as one unit.
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

// Three additive forward migrations applied as ONE guarded unit (each recorded in the history, all in one transaction).
export const MIGRATIONS = [
  { version: "20261108000001", name: "caterlink_fail_closed_containment", sha256: "ad8dbca5aed5ef4e9d7cbf0a23b1874ff3566707ca7345c3cd865b73c7089306" },
  { version: "20261109000001", name: "atomic_same_day_leave", sha256: "058b4afdcc7fe081cecc33e808088a241c0258b45eab75bb514c66f99e234671" },
  { version: "20261110000001", name: "registration_throttle", sha256: "3a2ea12506231afe272e4e04c803c6fd0b439a129b8268f532afe32490709369" },
  { version: "20261111000001", name: "vendor_check_signature_authorization", sha256: "f7e1f9741dc8a76c3ced1cabf873577896188cf367e6b78560fd14cae98d4b4f" },
  { version: "20261112000001", name: "block_unusable_driver_routes", sha256: "ae0ecb5ac2a2565385e542e56777c343fcf2684887717b955a75cec52b271ea2" },
];
export const PRE_COUNT = 83;
export const LAST_PRE = "20261107000001";
export const LIVE_PHRASE = `APPLY ${MIGRATIONS.map((m) => m.version).join("+")} TO STAGING ${APPROVED_REF}`;
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
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''");
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
      other: (await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) h from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname not in ('skip_part_d','raise_caterlink_incident_secure','confirm_caterlink_destination_receipt_secure','list_caterlink_pending_receipts_secure','caterlink_receipt_ready_statuses','caterlink_expected_receiving_station','submit_leave_application_secure','registration_throttle_hit','record_caterlink_vendor_security_check_secure','caterlink_vendor_check_upload_allowed','list_orphan_vendor_signatures_secure','enforce_completable_driver_route') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].h,
      profiles: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) h from public.profiles p"))[0].h,
      assignments: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') h from public.user_role_assignments a"))[0].h,
      transactions: (await q("select coalesce(md5(string_agg(md5(t::text), ',' order by t.id::text)), 'none') h from public.transactions t"))[0].h,
      incidents: (await q("select count(*)::text h from public.caterlink_incidents"))[0].h,
      hub: (await q("select count(*)::text h from public.caterlink_checkpoint_hub"))[0].h,
      jobs: (await q("select count(*)::text h from public.caterlink_pdf_jobs"))[0].h,
      policies: (await q("select md5(string_agg(schemaname || tablename || policyname || coalesce(qual,'') || coalesce(with_check,''), ',' order by schemaname, tablename, policyname)) h from pg_policies where schemaname in ('public','storage') and tablename <> 'absence_notices' and not (schemaname = 'storage' and policyname = 'signatures: vendor check upload is delivery-bound')"))[0].h,
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

        // wrong-station receipt: an officer at BKI cannot receive a KCH movement (destination binding), rolled back
        {
          await client.query("SAVEPOINT bind");
          await client.query("update public.transactions set status = 'AIRPORT_POST_APPROVED' where id = $1", [tx]);
          const wrong = await asUser("aso-bki-receipt", async () => { await client.query(`select * from ${RECEIPT.replace(/\(.*$/, "")}($1, 'BKI', 'receipt/dryrun.png', 'dry run')`, [tx]); return "ACCEPTED"; });
          if (!/not available for receipt confirmation at this station/i.test(wrong)) fail(`a wrong-station receipt was not refused uniformly (${wrong})`);
          await client.query("ROLLBACK TO SAVEPOINT bind");
        }
        // leave RPC and registration throttle: grants, policy, and a rolled-back behavioural probe
        const LEAVE = "public.submit_leave_application_secure(text, date, date, text)";
        const THROTTLE = "public.registration_throttle_hit(text, integer, integer)";
        const lg = (await q(`select has_function_privilege('anon', '${LEAVE}', 'execute') an, has_function_privilege('authenticated', '${LEAVE}', 'execute') au, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${LEAVE}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub`))[0];
        if (lg.an || lg.pub || !lg.au) fail("the leave RPC grants are not authenticated-only");
        const tg = (await q(`select has_function_privilege('anon', '${THROTTLE}', 'execute') an, has_function_privilege('authenticated', '${THROTTLE}', 'execute') au, has_function_privilege('service_role', '${THROTTLE}', 'execute') sv, has_table_privilege('authenticated', 'public.registration_throttle', 'select,insert,update,delete') tb`))[0];
        if (tg.an || tg.au || !tg.sv || tg.tb) fail("the registration throttle is not service-role only");
        const ins = (await q("select has_table_privilege('authenticated', 'public.absence_notices', 'insert') i, exists (select 1 from pg_policy where polrelid = 'public.absence_notices'::regclass and polname = 'absence_notices_insert_own') p"))[0];
        if (ins.i || ins.p) fail("a client can still insert absence notices directly");
        {
          const probe = await asUser("aso", async () => { const r = await client.query("select * from public.submit_leave_application_secure('annual', current_date + 400, current_date + 401, 'dry run probe')"); return r.rows[0]?.result_same_day === false ? "OK" : "UNEXPECTED"; });
          if (probe !== "OK") fail(`the leave RPC probe failed (${probe})`);
          const denied = await asUser("neg-pending-profile", async () => { await client.query("select * from public.submit_leave_application_secure('absent', null, null, 'x')"); return "ALLOWED"; });
          if (/ALLOWED/.test(denied)) fail("a pending profile could submit leave");
        }

        // vendor Part B signature: delivery-bound Storage policy, orphan listing grants, and the Driver route guard
        {
          const pol = await q("select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'signatures: vendor check upload is delivery-bound' and not polpermissive");
          if (pol.length !== 1) fail("the restrictive vendor-signature Storage policy is missing");
          const og = (await q("select has_function_privilege('authenticated', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') au, has_function_privilege('anon', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') an, has_function_privilege('service_role', 'public.list_orphan_vendor_signatures_secure(integer)', 'execute') sv"))[0];
          if (og.au || og.an || !og.sv) fail("the orphan listing is not service-role only");
          const denied = await asUser("aso", async () => { await client.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [`vendor-part-b/${ghost}/${ghost.replace(/c01$/, "c02")}.png`, acct("aso")]); return "ALLOWED"; });
          if (/ALLOWED/.test(denied) || !/row-level security|policy/i.test(denied)) fail(`an unauthorised vendor-signature upload was not refused by Storage RLS (${denied})`);
          const trg = await q("select tgenabled from pg_trigger where tgname = 'trg_enforce_completable_driver_route' and tgrelid = 'public.transactions'::regclass");
          if (trg.length !== 1 || trg[0].tgenabled !== "O") fail("the Driver route guard trigger is missing or disabled");
          await client.query("SAVEPOINT rg");
          await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'service_role', true)", [JSON.stringify({ sub: acct("caterlink-driver"), role: "authenticated" })]);
          const routeDenied = await client.query(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, created_by)
            values ('ICMS-2026-990998', $1, 'OUTBOUND', 'UAT-VEH', '[GUARD-DRYRUN]', 'UAT-DRV', 'S', 'CREATED', 'AIRCRAFT', $2, $3)`, [aoc, pen, acct("caterlink-driver")]).then(() => "ALLOWED").catch((e) => String(e.message));
          await client.query("ROLLBACK TO SAVEPOINT rg");
          if (!/not available yet/i.test(routeDenied)) fail(`a Driver AIRCRAFT movement was not refused by the route guard (${routeDenied.slice(0, 80)})`);
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
    const afterDry = await grants();
    if (JSON.stringify(afterDry) !== JSON.stringify(before)) fail("the dry run changed a grant");
    log("dry run left staging exactly as before (history count, helper absence and grants re-checked)");
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
