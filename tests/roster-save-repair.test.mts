import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenSql,MIGRATION,PRE_COUNT,PRE_LAST,BRANCH,validateSql} from '../scripts/staging/apply-roster-save-repair.mjs';
test('repair targets reviewed canonical roster columns',()=>{const sql=frozenSql();assert.match(sql,/on conflict \(station, team, roster_date\)/);assert.doesNotMatch(sql,/\bops_group\b/);});
test('approval and canonical scope checks retained',()=>{const sql=frozenSql();assert.match(sql,/status = 'approved'/);assert.match(sql,/can_manage_roster_secure\(p_station, p_team\)/);assert.match(sql,/auth\.uid\(\) is null/);});
test('only one function body may be replaced; never a table, grant or policy',()=>{assert.ok(validateSql(frozenSql()));for(const suffix of ['\ndrop table public.team_rosters;','\ngrant all on public.team_rosters to anon;','\ncreate policy leak on public.team_rosters using (true);'])assert.throws(()=>validateSql(frozenSql()+suffix));});
test('runner pre-state remains frozen at current hosted baseline',()=>{assert.equal(PRE_COUNT,109);assert.equal(PRE_LAST,'20261130000006');assert.equal(MIGRATION.version,'20261130000007');assert.equal(BRANCH,'fix/roster-canonical-save');});
