import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { gitGates, environmentGates, connectVerified, APPROVED_REF } from './lib/run-gates.mjs';
import { decryptBackupPayload } from './lib/backup-crypto.mjs';

export const MIGRATIONS = [{ version: '20261130000005', name: 'enable_kul_maa_caterlink_scan', sha256: '00f6be12cbd95c38c811d5b2950fa54edf01c292c1fca1b62422ce3d78348d50' }];
export const PRE_COUNT = 107, LAST_PRE = '20261130000004';
export const RUNNER_BRANCH = 'fix/caterlink-kul-maa-scanning';
export const LIVE_PHRASE = 'ENABLE KUL - MAA CATERLINK SCANNING ON STAGING ddlctzbnqewubltcavkh';
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const lf = x => String(x).replace(/\r\n?/g, '\n');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function frozenSql() {
 const m=MIGRATIONS[0],file=path.join(root,'supabase/migrations',m.version+'_'+m.name+'.sql'),sql=lf(fs.readFileSync(file,'utf8'));
 assert.equal(hash(sql),m.sha256,'Frozen migration differs');
 const versions=fs.readdirSync(path.join(root,'supabase/migrations')).filter(x=>/^\d{14}_/.test(x)).map(x=>x.slice(0,14)).sort();
 assert.equal(new Set(versions).size,versions.length,'Duplicate migration version');assert.equal(versions.filter(x=>x<=m.version).at(-1),m.version,'Migration sequence broken');return sql;
}
async function history(p){return(await p.query('select version,name from supabase_migrations.schema_migrations order by version')).rows;}
async function invariantSnapshot(p){
 const functions=(await p.query("select p.oid::regprocedure::text signature,replace(pg_get_functiondef(p.oid),chr(13),'') definition,p.proacl::text acl,p.proowner,p.prosecdef,p.provolatile,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1")).rows;
 const scan=functions.find(x=>x.signature.startsWith('can_user_scan_caterlink('));assert.ok(scan);
 const caps=(await p.query('select c.*,s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id=c.station_id order by c.id')).rows;
 const policies=(await p.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows;
 const triggers=(await p.query("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1,2")).rows;
 const immutable={};for(const table of ['profiles','user_role_assignments','org_stations'])immutable[table]=(await p.query('select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,\'[]\')) digest,count(*)::int count from public.'+table+' t')).rows[0];
 const grants=(await p.query("select * from information_schema.role_table_grants where table_schema='public' order by table_name,grantee,privilege_type")).rows;
 return{scan,caps,others:hash(functions.filter(x=>x!==scan)),policies:hash(policies),triggers:hash(triggers),immutable,grants:hash(grants)};
}
function compare(before,after){
 for(const k of ['others','policies','triggers','immutable','grants'])assert.deepEqual(after[k],before[k],k+' changed');
 assert.deepEqual({...after.scan,definition:undefined},{...before.scan,definition:undefined},'Function security properties changed');
 assert.equal(after.scan.definition.replace("('PEN', 'JHB', 'KUL - MAA')","('PEN', 'JHB')"),before.scan.definition,'Unexpected function change');
 assert.equal(after.caps.length,before.caps.length);let changed=0;
 for(let i=0;i<before.caps.length;i++){const old=before.caps[i],now=after.caps[i];if(old.code==='KUL - MAA'){assert.equal(now.can_scan,true);assert.deepEqual({...now,can_scan:undefined,updated_at:undefined},{...old,can_scan:undefined,updated_at:undefined});changed++;}else assert.deepEqual(now,old);}
 assert.equal(changed,1,'Expected exactly one KUL-MAA capability row');
}
async function probes(p,accounts){
 let count=0;for(const a of accounts){if(!a.authUserId)continue;await p.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:a.authUserId,role:'authenticated'})]);await p.query('set local role authenticated');
 const rows=(await p.query('select role_code,station_code,aoc_code from public.get_my_active_role_assignments()')).rows;const excluded=rows.some(x=>['profiling_so','profiling_aso'].includes(x.role_code));
 const stations=['KUL - MAA','KUL - AAX','PEN','JHB','BKI','KCH','BTU','KUL','UNKNOWN'];
 const decisions=(await p.query('select s,public.can_user_scan_caterlink(s) allowed from unnest($1::text[]) s',[stations])).rows;
 for(const d of decisions){const expected=!excluded&&['KUL - MAA','PEN','JHB'].includes(d.s)&&rows.some(x=>x.aoc_code==='MY'&&x.station_code===d.s&&['aso','so','sso','dse'].includes(x.role_code));assert.equal(d.allowed,expected,a.label+' @ '+d.s);count++;}
 assert.equal((await p.query("select public.can_user_scan_caterlink('KUL - MAA','00000000-0000-0000-0000-000000000000') allowed")).rows[0].allowed,false,'Wrong AOC accepted');count++;await p.query('reset role');}
 assert.equal((await p.query("select has_function_privilege('anon','public.can_user_scan_caterlink(text,uuid)','EXECUTE') allowed")).rows[0].allowed,false);return count+1;
}
export async function main(args=process.argv.slice(2)){
 const opt=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3),live=args.includes('--live');environmentGates();
 const head=opt('expected-head');assert.match(head||'',/^[a-f0-9]{40}$/);gitGates({expectedBase:head,expectedRepoPath:root,expectedBranch:RUNNER_BRANCH});
 if(live)assert.equal(opt('confirm'),LIVE_PHRASE,'Explicit staging phrase required');const sql=frozenSql(),backupPath=path.resolve(opt('backup')||'');assert.ok(!backupPath.startsWith(root+path.sep),'Backup must be outside repo');
 const backup=decryptBackupPayload(fs.readFileSync(backupPath,'utf8'),process.env.VECTA_BACKUP_PASSPHRASE);assert.equal(backup.projectRef,APPROVED_REF);assert.ok(Date.now()-Date.parse(backup.exportedAt)<3600000,'Backup older than one hour');assert.equal(backup.history.length,PRE_COUNT);assert.equal(backup.history.at(-1).version,LAST_PRE);
 const accounts=JSON.parse(fs.readFileSync(opt('accounts'),'utf8')).accounts;assert.ok(accounts.every(a=>!a.email||a.email.endsWith('@vecta.test')),'Only test accounts permitted');const{client:p}=await connectVerified();
 try{const original=await history(p);assert.equal(original.length,PRE_COUNT);assert.equal(original.at(-1).version,LAST_PRE);const before=await invariantSnapshot(p);
 const backupFn=backup.functions.find(x=>x.signature.startsWith('can_user_scan_caterlink('));assert.equal(lf(backupFn.definition),before.scan.definition,'Backup function does not match');
 async function pass(commit){await p.query('begin isolation level serializable');try{await p.query("set local lock_timeout='10s'");assert.deepEqual(await history(p),original);await p.query(sql);compare(before,await invariantSnapshot(p));const n=await probes(p,accounts);await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATIONS[0].version,MIGRATIONS[0].name]);const h=await history(p);assert.equal(h.length,108);assert.deepEqual(h.slice(0,-1),original);await p.query(commit?'commit':'rollback');return n;}catch(e){await p.query('rollback');throw e;}}
 const dry=await pass(false);assert.deepEqual(await history(p),original);assert.deepEqual(await invariantSnapshot(p),before,'Rollback did not restore state');console.log('DRY RUN PASS',dry,'access probes; rollback verified');
 if(live){const applied=await pass(true);compare(before,await invariantSnapshot(p));assert.equal((await history(p)).length,108);console.log('LIVE APPLY PASS',applied,'access probes; history 108 ending 20261130000005');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
