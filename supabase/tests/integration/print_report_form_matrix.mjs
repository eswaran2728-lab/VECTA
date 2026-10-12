// Prints the SANITIZED report-form assignment matrix (station x role/function x permitted forms) from the migrated golden database
// and asserts the seed invariants. No user identity is read or printed: only report_form_assignments and the role/station catalogues.
// Run AFTER `node migrate.mjs --native`:   node print_report_form_matrix.mjs
import pg from 'pg';

const { Client } = pg;
const cfg = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined, database: process.env.PGDATABASE || 'vecta_phase6_test' };
const FORMS = ['sec013', 'sec014', 'sec016', 'sec018', 'sec029', 'sec033', 'offload'];
let failures = 0;
const check = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else console.log('PASS:', m); };

const db = new Client(cfg);
await db.connect();
const stations = (await db.query('select code from public.org_stations where is_active order by code;')).rows.map((r) => r.code);
const roles = (await db.query('select code from public.role_definitions order by code;')).rows.map((r) => r.code);
const rows = (await db.query('select role_code, station_code, form_type from public.report_form_assignments where revoked_at is null and profile_id is null;')).rows;

const formsFor = (role, station) => FORMS.filter((f) => rows.some((r) => r.role_code === role && r.form_type === f && (r.station_code === station || r.station_code === null)));

console.log('\nSTATION x ROLE/FUNCTION -> PERMITTED REPORT FORMS (roles with no form are omitted; every other role has none)');
console.log('station'.padEnd(14), 'role/function'.padEnd(14), 'forms');
for (const st of stations) for (const role of roles) { const f = FORMS.filter((x) => rows.some((r) => r.role_code === role && r.form_type === x && r.station_code === st)); if (f.length) console.log(st.padEnd(14), role.padEnd(14), f.join(', ')); }
console.log('\nROLE-WIDE ROWS (not station-scoped; the only ones that exist)');
for (const r of rows.filter((x) => x.station_code === null)) console.log('(all)'.padEnd(14), r.role_code.padEnd(14), r.form_type);
console.log('\nROLE -> FORMS ACROSS ALL STATIONS');
for (const role of roles) console.log(role.padEnd(32), (new Set(stations.flatMap((s) => formsFor(role, s)))).size ? [...new Set(stations.flatMap((s) => formsFor(role, s)))].sort().join(', ') : '(none)');

console.log('');
const standard = ['sec014', 'sec016', 'sec018', 'sec029', 'sec033', 'offload'];
check(!rows.some((r) => r.role_code === 'aso' && r.station_code === null), 'no global / all-station ASO fallback row is seeded');
check(stations.every((s) => formsFor('aso', s).sort().join() === standard.slice().sort().join()), 'every active station receives exactly the current standard-ASO default (SEC014, SEC016, SEC018, SEC029, SEC033, Offload)');
check(stations.every((s) => !formsFor('aso', s).includes('sec013')), 'standard ASO never gets SEC013');
check(rows.filter((r) => r.role_code === 'profiling_aso').every((r) => r.form_type === 'sec013') && rows.some((r) => r.role_code === 'profiling_aso'), 'Profiling ASO gets SEC013 only');
check(rows.filter((r) => r.role_code === 'profiling_aso').every((r) => r.station_code === null), 'Profiling ASO is not station-scoped, so its single SEC013 row is role-wide by design');
for (const r of ['profiling_so', 'sat_aso']) check(!rows.some((x) => x.role_code === r), `${r} gets no form`);
const others = [...new Set(rows.map((r) => r.role_code))].filter((r) => !['aso', 'profiling_aso'].includes(r));
check(others.length === 0, `no other role is seeded (found: ${others.join(', ') || 'none'})`);
check(rows.filter((r) => r.role_code === 'aso' && r.form_type === 'offload').length === stations.length, 'Offload is an explicit row at every active station (not implied)');
await db.end();
console.log(`\nMATRIX CHECKS: ${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
