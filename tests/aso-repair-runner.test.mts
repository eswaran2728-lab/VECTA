import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  frozenSql,
  MIGRATIONS,
  PRE_COUNT,
  LAST_PRE,
  RUNNER_BRANCH,
  LIVE_PHRASE
} from '../scripts/staging/apply-aso-repair-migration.mjs';

test('ASO repair runner freezes one forward migration and the exact staging pre-state (108 ending 20261130000005)', () => {
  assert.equal(PRE_COUNT, 108);
  assert.equal(LAST_PRE, '20261130000005');
  assert.equal(MIGRATIONS.length, 1);
  assert.equal(MIGRATIONS[0].version, '20261130000006');
  assert.equal(MIGRATIONS[0].name, 'repair_aso_declaration_and_history');
  assert.equal(RUNNER_BRANCH, 'fix/caterlink-kul-maa-scanning');
  assert.match(LIVE_PHRASE, /STAGING ddlctzbnqewubltcavkh$/);
  const sql = frozenSql();
  assert.match(sql, /report_sec029_declaration_check/);
  assert.match(sql, /report_source_summary/);
  assert.match(sql, /list_my_submissions_secure/);
});

test('ASO repair runner keeps explicit backup, git, environment, transactional and rollback gates', () => {
  const s = fs.readFileSync(
    path.resolve(import.meta.dirname, '../scripts/staging/apply-aso-repair-migration.mjs'),
    'utf8'
  );
  for (const term of [
    'gitGates({ expectedBase: head',
    'environmentGates()',
    'decryptBackupPayload',
    '3600000',
    'isolation level serializable',
    'pass(false)',
    'Rollback did not restore state',
    'if (live)',
    'await pass(true)',
    'role authenticated'
  ]) {
    assert.ok(s.includes(term), term);
  }
  assert.ok(s.indexOf('const dryProbes = await pass(false)') < s.indexOf('await pass(true)'));
});

