// Durable post-receipt PDF jobs (migration 20261105000001): genuine multi-connection concurrency verification.
//  1. Two concurrent workers claiming from the same queue receive DISJOINT jobs (FOR UPDATE SKIP LOCKED), none twice.
//  2. Two concurrent workers completing the SAME job (with different re-rendered bytes) yield exactly ONE authoritative version:
//     the second blocks on the job row lock, then receives the existing version.
// Requires native PostgreSQL. Run from this directory AFTER `node migrate.mjs --native`.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  connectionTimeoutMillis: 15000,
  query_timeout: 20000,
  statement_timeout: 20000,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_pdf_jobs_concurrency_run';
const OVERALL_TIMEOUT_MS = 60000;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openClients = [];
function trackedClient(database) {
  const c = new Client({ ...pgConfig, database });
  openClients.push(c);
  return c;
}
async function asService(c) {
  await c.query('reset role;');
  await c.query("set role 'service_role';");
  await c.query("select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false);");
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== PDF job concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
  const admin = trackedClient('postgres');
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = trackedClient(runDb);
  await setup.connect();
  const aoc = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const kul = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const receiver = '00000000-0000-0000-0000-0000000000c1';
  await setup.query("insert into auth.users (id, email) values ($1, 'pdfjob-rc@example.test') on conflict (id) do nothing;", [receiver]);
  await setup.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'pdfjob-rc@example.test','PDF Job RC','PJ-1','ASO','approved') on conflict (id) do nothing;", [receiver]);
  const tx = [];
  for (let i = 1; i <= 3; i++) {
    const id = `00000000-0000-0000-0000-0000000000d${i}`;
    tx.push(id);
    await setup.query('set session_replication_role = replica;');
    await setup.query(
      `insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, hub_destination, origin_station_id, flight_number, created_by)
       values ($1,$2,$3,'OUTBOUND','WPJ${i}','Driver','D1','S-${i}','INFLIGHT_POST_APPROVED','HUB','BKI',$4,'AK703',$5);`,
      [id, `TX-PDFJOB-${i}`, aoc, kul, receiver],
    );
    await setup.query("insert into public.caterlink_checkpoint_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, completed_by) values ($1,'BKI','RC','RC-1','s.png',$2);", [id, receiver]);
    await setup.query('set session_replication_role = origin;');
    await setup.query("update public.transactions set status = 'COMPLETED' where id = $1;", [id]); // fires the job trigger
  }
  const queued = (await setup.query("select count(*)::int n from public.caterlink_pdf_jobs where status = 'pending';")).rows[0].n;
  assert(queued === 3, 'three completions created three pending jobs');

  const a = trackedClient(runDb);
  const b = trackedClient(runDb);
  await a.connect();
  await b.connect();
  await asService(a);
  await asService(b);

  // ---- 1. concurrent claims are disjoint
  await a.query('begin;');
  await b.query('begin;');
  const claimA = (await a.query('select job_id from public.claim_caterlink_pdf_jobs(2, null);')).rows.map((r) => r.job_id);
  const claimB = (await b.query('select job_id from public.claim_caterlink_pdf_jobs(5, null);')).rows.map((r) => r.job_id);
  assert(claimA.length === 2, 'worker A claimed two jobs (uncommitted)');
  assert(claimB.length === 1 && !claimA.includes(claimB[0]), 'worker B, running concurrently, skipped A\'s locked rows and claimed only the remaining job');
  await a.query('commit;');
  await b.query('commit;');
  const processing = (await setup.query("select count(*)::int n, count(distinct id)::int d from public.caterlink_pdf_jobs where status = 'processing';")).rows[0];
  assert(processing.n === 3 && processing.d === 3, 'every job is held by exactly one worker');

  // ---- 2. concurrent completion of the same job -> one authoritative version
  const job = (await setup.query('select id, transaction_id from public.caterlink_pdf_jobs where transaction_id = $1;', [tx[0]])).rows[0];
  const h1 = 'a'.repeat(64);
  const h2 = 'b'.repeat(64);
  await a.query('begin;');
  await b.query('begin;');
  const doneA = (await a.query('select * from public.complete_caterlink_pdf_job($1,$2,$3,4000);', [job.id, `${tx[0]}/${h1}.pdf`, h1])).rows[0];
  let bBlocked = true;
  const bPromise = b.query('select * from public.complete_caterlink_pdf_job($1,$2,$3,4100);', [job.id, `${tx[0]}/${h2}.pdf`, h2]).then((r) => { bBlocked = false; return r.rows[0]; });
  await sleep(400);
  assert(bBlocked, 'worker B is blocked on the job row while worker A holds the uncommitted completion');
  await a.query('commit;');
  const doneB = await bPromise;
  await b.query('commit;');
  assert(doneA.version === 1 && doneA.is_new === true, 'worker A recorded version 1');
  assert(doneB.version === 1 && doneB.is_new === false && doneB.pdf_id === doneA.pdf_id, 'worker B received the existing version, not a second one');
  const pdfs = (await setup.query('select version, content_hash from public.caterlink_transaction_pdfs where transaction_id = $1;', [tx[0]])).rows;
  assert(pdfs.length === 1 && pdfs[0].content_hash === h1, 'exactly one authoritative version exists');
  const audits = (await setup.query("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_pdf_job_succeeded' and entity_id = $1;", [tx[0]])).rows[0].n;
  assert(audits === 1, 'successful generation was audited once');
  console.log('\nScenarios PASSED with verified transaction overlap.');
}

const watchdog = setTimeout(() => {
  console.error(`FAILED: exceeded ${OVERALL_TIMEOUT_MS}ms -- treat as a hang, not a pass.`);
  process.exitCode = 1;
  for (const c of openClients) c.end().catch(() => {});
  setTimeout(() => process.exit(1), 500);
}, OVERALL_TIMEOUT_MS);

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    clearTimeout(watchdog);
    for (const c of openClients) { await c.query('rollback;').catch(() => {}); await c.end().catch(() => {}); }
  });
