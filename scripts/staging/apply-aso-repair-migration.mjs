import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gitGates, environmentGates, connectVerified, APPROVED_REF } from './lib/run-gates.mjs';
import { decryptBackupPayload } from './lib/backup-crypto.mjs';

export const MIGRATIONS = [
  {
    version: '20261130000006',
    name: 'repair_aso_declaration_and_history',
    sha256: 'e2d778a161922742541edcf8e379e14bd1a7553972a39ded1af6c7b9d07262b2'
  }
];

export const PRE_COUNT = 108;
export const LAST_PRE = '20261130000005';
export const RUNNER_BRANCH = 'fix/caterlink-kul-maa-scanning';
export const LIVE_PHRASE = 'REPAIR ASO DECLARATION AND HISTORY ON STAGING ddlctzbnqewubltcavkh';

const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const lf = x => String(x).replace(/\r\n?/g, '\n');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function frozenSql() {
  const m = MIGRATIONS[0];
  const file = path.join(root, 'supabase/migrations', m.version + '_' + m.name + '.sql');
  const sql = lf(fs.readFileSync(file, 'utf8'));
  assert.equal(hash(sql), m.sha256, 'Frozen migration differs');
  const versions = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(x => /^\d{14}_/.test(x)).map(x => x.slice(0, 14)).sort();
  assert.equal(new Set(versions).size, versions.length, 'Duplicate migration version');
  assert.equal(versions.filter(x => x <= m.version).at(-1), m.version, 'Migration is not latest in sequence');
  return sql;
}

async function history(p) {
  return (await p.query('select version, name from supabase_migrations.schema_migrations order by version')).rows;
}

async function invariantSnapshot(p) {
  const functions = (await p.query(
    "select p.oid::regprocedure::text signature, replace(pg_get_functiondef(p.oid), chr(13), '') definition, p.proacl::text acl, p.proowner, p.prosecdef, p.provolatile, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('list_my_submissions_secure', 'report_source_summary') order by 1"
  )).rows;
  const constraints = (await p.query(
    "select conname, pg_get_constraintdef(oid) definition from pg_constraint where conrelid='public.report_sec029'::regclass and conname='report_sec029_declaration_check'"
  )).rows;
  return { functions, constraints };
}

async function unaffectedSnapshot(p) {
  const definitions = (await p.query("select p.oid::regprocedure::text signature, replace(pg_get_functiondef(p.oid),chr(13),'') definition,p.proacl::text acl,p.proowner,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('list_my_submissions_secure','report_source_summary') order by 1")).rows;
  const policies = (await p.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  const triggers = (await p.query("select t.tgrelid::regclass::text relation,t.tgname,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1,2")).rows;
  const counts = (await p.query('select (select count(*) from auth.users)::int users,(select count(*) from public.profiles)::int profiles,(select count(*) from public.user_role_assignments)::int assignments,(select count(*) from storage.objects)::int storage')).rows;
  return {definitions,policies,triggers,counts};
}

async function probes(p, accounts) {
  let probeCount = 0;
  const asoAccount = accounts.find(x => x.label === 'aso-kul') || accounts.find(x => x.label === 'aso');
  assert.ok(asoAccount, 'ASO test account required');

  // Evaluate the actual hosted constraint on a transaction-local scratch relation.
  // No incomplete report is inserted and no application trigger is bypassed.
  await p.query('savepoint sec029_probe');
  try {
    const expression=(await p.query("select pg_get_expr(conbin,conrelid) expression from pg_constraint where conrelid='public.report_sec029'::regclass and conname='report_sec029_declaration_check'")).rows[0].expression;
    await p.query('create temporary table aso_declaration_probe(declaration text check ('+expression+')) on commit drop');
    // Current Rev.03 non-discrepancy
    await p.query(
      "insert into aso_declaration_probe values ('I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.')"
    );
    probeCount++;
    // Current Rev.03 discrepancy
    await p.query(
      "insert into aso_declaration_probe values ('DISCREPANCIES FOUND AND DUTY SECURITY EXECUTIVE / DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW).')"
    );
    probeCount++;
    // Legacy non-discrepancy
    await p.query(
      "insert into aso_declaration_probe values ('I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.')"
    );
    probeCount++;
    // Legacy discrepancy
    await p.query(
      "insert into aso_declaration_probe values ('DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)')"
    );
    probeCount++;

    // Arbitrary text must fail
    let arbitraryFailed = false;
    try {
      await p.query(
        "insert into aso_declaration_probe values ('ARBITRARY DECLARATION TEXT')"
      );
    } catch (e) {
      arbitraryFailed = e.code === '23514';
    }
    assert.ok(arbitraryFailed, 'Arbitrary declaration rejected');
    probeCount++;
  } finally {
    await p.query('rollback to savepoint sec029_probe');
  }

  // 2. report_source_summary SEC016 casting probe (verifies no 42804 time casting error)
  const summarySec016 = await p.query(
    "select * from public.report_source_summary('report_sec016', '00000000-0000-0000-0000-000000000000')"
  );
  assert.equal(summarySec016.rowCount, 0, 'Zero rows for non-existent row, no 42804 type error');
  probeCount++;

  // 3. Signed-in ASO probe via RPC
  await p.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: asoAccount.authUserId, role: 'authenticated' })]);
  await p.query('set local role authenticated');
  const historyRows = (await p.query('select * from public.list_my_submissions_secure(200)')).rows;
  assert.ok(Array.isArray(historyRows), 'History rows returned');
  for (const row of historyRows) {
    assert.ok(['report_sec013','report_sec014','report_sec016','report_sec018','report_sec029','report_sec033','offload_records','report_makeup','report_breakup'].includes(row.source_table));
  }
  probeCount++;
  await p.query('reset role');

  // 4. Reset role to unauthenticated and verify signed-out protection
  await p.query("select set_config('request.jwt.claims', '{}', true)");
  await p.query('savepoint unauth_probe');
  let unauthBlocked = false;
  try {
    await p.query('select * from public.list_my_submissions_secure(20)');
  } catch (e) {
    if (/must be signed in/i.test(e.message)) unauthBlocked = true;
  }
  assert.ok(unauthBlocked, 'Unauthenticated access rejected with "Must be signed in."');
  await p.query('rollback to savepoint unauth_probe');
  probeCount++;

  return probeCount;
}

export async function main(args = process.argv.slice(2)) {
  const opt = k => args.find(x => x.startsWith('--' + k + '='))?.slice(k.length + 3);
  const live = args.includes('--live');
  environmentGates();

  const head = opt('expected-head');
  assert.match(head || '', /^[a-f0-9]{40}$/);
  gitGates({ expectedBase: head, expectedRepoPath: root, expectedBranch: RUNNER_BRANCH });

  if (live) {
    assert.equal(opt('confirm'), LIVE_PHRASE, 'Explicit staging phrase required');
  }

  const sql = frozenSql();
  const backupPath = path.resolve(opt('backup') || '');
  assert.ok(!backupPath.startsWith(root + path.sep), 'Backup must be outside repo');

  const backup = decryptBackupPayload(fs.readFileSync(backupPath, 'utf8'), process.env.VECTA_BACKUP_PASSPHRASE);
  assert.equal(backup.projectRef, APPROVED_REF);
  assert.ok(Date.now() - Date.parse(backup.exportedAt) < 3600000, 'Backup older than one hour');
  assert.equal(backup.history.length, PRE_COUNT);
  assert.equal(backup.history.at(-1).version, LAST_PRE);

  const accounts = JSON.parse(fs.readFileSync(opt('accounts'), 'utf8')).accounts;
  assert.ok(accounts.every(a => !a.email || a.email.endsWith('@vecta.test')), 'Only test accounts permitted');

  const { client: p } = await connectVerified();

  try {
    const original = await history(p);
    assert.equal(original.length, PRE_COUNT);
    assert.equal(original.at(-1).version, LAST_PRE);

    const before = await invariantSnapshot(p);
    for (const fn of before.functions) assert.equal((await p.query('select pg_get_userbyid($1::oid) owner',[fn.proowner])).rows[0].owner,'postgres','Reviewed function owner changed');
    const unaffected = await unaffectedSnapshot(p);

    async function pass(commit) {
      await p.query('begin isolation level serializable');
      try {
        await p.query("set local lock_timeout='10s'");
        assert.deepEqual(await history(p), original);
        await p.query(sql);

        const after = await invariantSnapshot(p);
        assert.notDeepEqual(after, before, 'Snapshots must reflect repair changes');
        for (const fn of after.functions) {
          const old=before.functions.find(x=>x.signature===fn.signature);
          assert.ok(old);
          for (const property of ['acl','proowner','prosecdef','provolatile','proconfig']) assert.deepEqual(fn[property],old[property],property+' changed');
        }

        const n = await probes(p, accounts);
        assert.deepEqual(await unaffectedSnapshot(p),unaffected,'Unrelated schema or protected counts changed');

        await p.query('insert into supabase_migrations.schema_migrations(version, name) values($1, $2)', [
          MIGRATIONS[0].version,
          MIGRATIONS[0].name
        ]);

        const h = await history(p);
        assert.equal(h.length, 109);
        assert.deepEqual(h.slice(0, -1), original);
        assert.equal(h.at(-1).version, '20261130000006');

        await p.query(commit ? 'commit' : 'rollback');
        return n;
      } catch (e) {
        await p.query('rollback');
        throw e;
      }
    }

    // 1. Dry run
    const dryProbes = await pass(false);
    assert.deepEqual(await history(p), original);
    assert.deepEqual(await invariantSnapshot(p), before, 'Rollback did not restore state');
    console.log('DRY RUN PASS', dryProbes, 'probes; rollback verified');

    // 2. Live run
    if (live) {
      const applied = await pass(true);
      const postHistory = await history(p);
      assert.equal(postHistory.length, 109);
      assert.equal(postHistory.at(-1).version, '20261130000006');
      console.log('LIVE APPLY PASS', applied, 'probes; history 109 ending 20261130000006');
    }
  } finally {
    await p.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('RUNNER FAILED:', e.message, '\nSTACK:', e.stack);
    process.exitCode = 1;
  });
}
