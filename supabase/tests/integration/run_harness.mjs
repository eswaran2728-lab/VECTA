// Runs supabase/tests/phase6_integration_harness.sql's executable block
// (scenarios 1-11, 13-25, 27-29) against a PGlite instance already
// built by migrate.mjs. Reports each top-level scenario individually
// (bisecting at "-- SCENARIO N" markers) so a failure names the exact
// scenario, and reports total assertion counts.
//
// Run from this directory, AFTER `node migrate.mjs` has built ./pgdata:
//   node run_harness.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '../phase6_integration_harness.sql');
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_harness_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function main() {
  if (!fs.existsSync(GOLDEN_DATA_DIR)) {
    console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.');
    process.exit(1);
  }
  // Work on a throwaway copy so this can be re-run repeatedly without
  // re-running migrate.mjs, and so a failed run's partial state never
  // contaminates the golden post-migration snapshot.
  copyDir(GOLDEN_DATA_DIR, RUN_DATA_DIR);

  const db = new PGlite(RUN_DATA_DIR);
  await db.exec('set check_function_bodies = off;');

  const harness = fs.readFileSync(HARNESS_PATH, 'utf8');
  const start = harness.indexOf('begin;');
  const end = harness.indexOf('rollback;') + 'rollback;'.length;
  if (start === -1 || end === -1) {
    console.error('ERROR: could not find begin;/rollback; markers in the harness file.');
    process.exit(1);
  }
  const preamble = harness.slice(start, harness.indexOf('-- SCENARIO 1:'));
  const body = harness.slice(harness.indexOf('-- SCENARIO 1:'), end);

  const markerRe = /^-- SCENARIO \d+.*$/gm;
  const markers = [...body.matchAll(markerRe)].map((m) => m.index);
  markers.push(body.length);

  const results = [];
  try {
    await db.exec(preamble);
    results.push({ label: '(setup: helpers, fixtures)', status: 'OK' });
  } catch (e) {
    results.push({ label: '(setup: helpers, fixtures)', status: 'FAIL', error: e.message });
    report(results);
    await db.close();
    process.exit(1);
  }

  for (let i = 0; i < markers.length - 1; i++) {
    const chunk = body.slice(markers[i], markers[i + 1]);
    const title = chunk.split('\n')[0];
    // Static, reproducible assertion count: every `pg_temp.assert(` call
    // in this scenario's own text. If the scenario block completes
    // without throwing, every one of these calls did not raise --
    // pg_temp.assert() itself raises an exception on any failing
    // condition, so "scenario OK" and "every assertion in it passed"
    // are the same fact, just counted two ways.
    const assertionCount = (chunk.match(/pg_temp\.assert\(/g) || []).length;
    try {
      await db.exec(chunk);
      results.push({ label: title, status: 'OK', assertionCount });
    } catch (e) {
      results.push({ label: title, status: 'FAIL', error: e.message, assertionCount });
      break; // subsequent scenarios depend on prior fixtures/state
    }
  }

  await db.close();
  report(results);
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

function report(results) {
  console.log('\n=== HARNESS SCENARIO RESULTS ===');
  for (const r of results) {
    const assertPart = r.assertionCount !== undefined ? ` (${r.assertionCount} assertion${r.assertionCount === 1 ? '' : 's'})` : '';
    console.log(`${r.status}  ${r.label}${assertPart}${r.error ? '  -- ' + r.error : ''}`);
  }
  const ok = results.filter((r) => r.status === 'OK').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const totalAssertions = results.filter((r) => r.status === 'OK').reduce((sum, r) => sum + (r.assertionCount || 0), 0);
  console.log(`\n${ok} scenario blocks OK, ${fail} FAILED, ${results.length} total.`);
  console.log(`${totalAssertions} pg_temp.assert() calls passed across all OK scenario blocks.`);
  console.log('\nNote: Scenario 12 (documented cross-transaction concurrency) and');
  console.log('Scenario 26 (real two-session concurrency test) are NOT part of this');
  console.log('executable block -- see the harness file\'s own comments for their');
  console.log('separate, manual two-connection procedures and current status.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
