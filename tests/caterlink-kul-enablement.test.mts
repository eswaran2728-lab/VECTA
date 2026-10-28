import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCAN_ENABLED_STATIONS, caterlinkCapabilityFor } from '../scripts/staging/lib/team-plan.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('KUL-MAA operators are included without enabling other KUL or receipt-only stations',()=>{
 assert.deepEqual([...SCAN_ENABLED_STATIONS].sort(),['JHB','KUL - MAA','PEN']);
 for(const role of ['aso','so','sso','dse']){
  assert.match(caterlinkCapabilityFor(role,'approved',{station:'KUL - MAA'}),/^scan\/movement allowed/);
  for(const station of ['KUL - AAX','KUL','BKI','KCH','BTU'])assert.match(caterlinkCapabilityFor(role,'approved',{station}),/^denied/);
  assert.match(caterlinkCapabilityFor(role,'pending',{station:'KUL - MAA'}),/^denied/);
 }
});
test('new forward migration preserves the historical identity and assignment guards',()=>{
 const previous=fs.readFileSync(path.join(root,'supabase/migrations/20261021000001_phase9_caterlink_scan_authorization_correction.sql'),'utf8').replace(/\r\n?/g,'\n');
 const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261130000005_enable_kul_maa_caterlink_scan.sql'),'utf8');
 assert.match(sql,/p_station_code not in \('PEN', 'JHB', 'KUL - MAA'\)/);
 for(const pattern of [/auth\.uid\(\)/,/p\.status = 'approved'/,/ura\.station_id = v_station_id/,/ura\.aoc_id = v_aoc_id/,/rd\.is_active/,/ura\.revoked_at is null/,/ura\.starts_at <= now\(\)/,/ura\.ends_at > now\(\)/,/profiling_so/,/check_station_caterlink_capability\(v_aoc_id, p_station_code, 'scan'\)/])assert.match(sql,pattern);
 const body=(s:string)=>s.slice(s.indexOf('declare\n'),s.indexOf('end;\n',s.indexOf('declare\n'))+5).replace("('PEN', 'JHB', 'KUL - MAA')","('PEN', 'JHB')").replace(/\r\n?/g,'\n');
 assert.equal(body(sql),body(previous));
 assert.doesNotMatch(sql,/drop function|alter policy|disable trigger|session_replication_role|can_confirm_hub_receipt\s*=/i);
 assert.match(sql,/s\.code='KUL - MAA'/);
});
