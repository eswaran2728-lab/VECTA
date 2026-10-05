#!/usr/bin/env node
// Read-only inspection of the staging RLS / grant surface and survival counts.
// READ ONLY transaction over verified TLS. Prints object names, flags and counts only --
// never row data, never credentials.
//
// Usage: node --env-file=.env.local scripts/staging/inspect-rls-surface.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { buildVerifiedClientConfig } from "./lib/db-tls.mjs";

const APPROVED_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_REF = "zsxneokqulktgnccxgkz";
const require = createRequire(import.meta.url);
function loadPg() {
  try {
    return require("pg");
  } catch {
    return require(path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg"));
  }
}
const { Client } = loadPg();

async function main() {
  const dbUrl = process.env.STAGING_DATABASE_URL;
  if (!dbUrl) throw new Error("STAGING_DATABASE_URL is not set");
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) throw new Error("Forbidden production reference present in the environment");
  const u = new URL(dbUrl);
  if (!u.hostname.includes(APPROVED_REF) && !u.username.includes(APPROVED_REF)) throw new Error("Database URL does not identify the approved staging project");
  const cfg = buildVerifiedClientConfig(dbUrl);
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  await client.connect();
  const out = {};
  try {
    await client.query("BEGIN READ ONLY");
    const q = async (sql, p) => (await client.query(sql, p)).rows;

    out.noRls = await q(`
      select c.relname table_name,
             (select count(*)::int from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) columns,
             has_table_privilege('anon', c.oid, 'select') anon_select,
             has_table_privilege('authenticated', c.oid, 'select') auth_select,
             has_table_privilege('authenticated', c.oid, 'insert') auth_insert,
             has_table_privilege('authenticated', c.oid, 'update') auth_update,
             has_table_privilege('authenticated', c.oid, 'delete') auth_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
      order by 1`);
    out.forAllPolicies = await q(`select tablename, policyname, roles::text roles, (qual is not null) has_using, (with_check is not null) has_check from pg_policies where schemaname = 'public' and cmd = 'ALL' order by 1, 2`);
    out.truePolicies = await q(`select tablename, policyname, cmd, roles::text roles from pg_policies where schemaname = 'public' and (coalesce(qual,'') = 'true' or coalesce(with_check,'') = 'true') order by 1, 2`);
    out.anonGrants = await q(`
      select c.relname table_name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p') and has_table_privilege('anon', c.oid, 'select,insert,update,delete') order by 1`);
    out.anonFunctions = await q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
    out.publicFunctions = await q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') order by 1`);
    out.absentIcms = await q(`
      select t.name, to_regclass('public.' || t.name) is not null present
      from (values ('users'),('incidents'),('segment_timeouts'),('part_a'),('part_b_c'),('part_d'),('part_hub'),('part_redq'),('vendor_transactions'),('vendor_parts'),('seals'),('seal_verifications'),('catering_companies'),('drivers'),('vehicles'),('transactions'),('caterlink_incidents'),('caterlink_archives'),('caterlink_station_capabilities')) t(name) order by 1`);

    // Data API exposure (PostgREST) -- authenticator / db settings only, no secrets.
    out.dataApi = await q(`
      select r.rolname, coalesce((select array_to_string(rc.setconfig, ';') from pg_db_role_setting rc where rc.setrole = r.oid and rc.setdatabase = 0), '') settings
      from pg_roles r where r.rolname in ('authenticator', 'anon', 'authenticated', 'service_role') order by 1`);

    // Survival counts
    const one = async (sql) => (await q(sql))[0];
    out.counts = {
      authUsers: (await one(`select count(*)::int n from auth.users`)).n,
      profiles: (await one(`select count(*)::int n from public.profiles`)).n,
      orgTeams: (await one(`select count(*)::int n from public.org_teams`)).n,
      buckets: (await one(`select count(*)::int n from storage.buckets`)).n,
      activeAssignmentsOnExistingProfiles: (await one(`
        select count(*)::int n from public.user_role_assignments ura
        join public.role_definitions rd on rd.id = ura.role_definition_id
        join public.profiles p on p.id = ura.profile_id
        where rd.is_active and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())`)).n,
      profilesWithAnyAssignment: (await one(`select count(distinct profile_id)::int n from public.user_role_assignments`)).n,
    };
    out.migrations = await one(`select count(*)::int n, max(version) last from supabase_migrations.schema_migrations`);
    out.profileFingerprint = await one(`select md5(string_agg(md5(p::text), ',' order by p.id::text)) fp from public.profiles p`);
    out.authFingerprint = await one(`select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) fp from auth.users u`);
    out.prodRefInMigrationHistory = (await one(`select count(*)::int n from supabase_migrations.schema_migrations where name ilike '%${FORBIDDEN_REF}%'`)).n;
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(out, null, 1));
}

main().catch((e) => {
  console.error("inspect-rls-surface failed:", String(e && e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"));
  process.exit(1);
});
