#!/usr/bin/env node
// Read-only inspection of the staging database's authorization surface:
// which RLS policies, functions and triggers still depend on the legacy
// profile rank, ops_group or the ICMS users table. Runs inside a READ ONLY
// transaction over verified TLS; prints object names and boolean flags only
// (never row data).
//
// Usage: node --env-file=.env.local scripts/staging/inspect-authorization-surface.mjs [--json]
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

const DEPENDENCIES = {
  ops_group: /ops_group/i,
  legacy_profile_role: /(profiles|p)\.role|role::text|user_role/i,
  icms_users_table: /public\.users|from users|join users|\busers u\b/i,
  canonical: /has_active_role|has_role_in_scope|has_active_role_for_aoc|has_active_role_in_aoc|user_role_assignments|get_my_active_role_assignments|has_any_active_assignment/i,
};

function flags(text) {
  const f = {};
  for (const [k, re] of Object.entries(DEPENDENCIES)) f[k] = re.test(text ?? "");
  return f;
}

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

    const tables = await q(`
      select c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced,
             has_table_privilege('anon', c.oid, 'select,insert,update,delete') anon_any,
             has_table_privilege('authenticated', c.oid, 'select') auth_select,
             has_table_privilege('authenticated', c.oid, 'insert') auth_insert,
             has_table_privilege('authenticated', c.oid, 'update') auth_update,
             has_table_privilege('authenticated', c.oid, 'delete') auth_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by c.relname`);
    out.tables_without_rls = tables.filter((t) => !t.rls).map((t) => t.relname);
    out.tables_anon_privileges = tables.filter((t) => t.anon_any).map((t) => t.relname);
    out.table_count = tables.length;

    const policies = await q(`select tablename, policyname, cmd, permissive, roles, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname`);
    out.policy_count = policies.length;
    out.policies = policies
      .map((p) => ({ table: p.tablename, policy: p.policyname, cmd: p.cmd, permissive: p.permissive, roles: p.roles, ...flags(`${p.qual} ${p.with_check}`) }))
      .filter((p) => p.ops_group || p.legacy_profile_role || p.icms_users_table);
    out.policies_canonical_only_count = policies.filter((p) => flags(`${p.qual} ${p.with_check}`).canonical).length;

    const fns = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef secdef, pg_get_functiondef(p.oid) def,
                                has_function_privilege('authenticated', p.oid, 'execute') auth_exec, has_function_privilege('anon', p.oid, 'execute') anon_exec
                         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by p.proname`);
    out.function_count = fns.length;
    out.functions = fns
      .map((f) => ({ fn: `${f.proname}(${f.args})`, secdef: f.secdef, auth_exec: f.auth_exec, anon_exec: f.anon_exec, ...flags(f.def) }))
      .filter((f) => f.ops_group || f.legacy_profile_role || f.icms_users_table);
    out.functions_anon_executable = fns.filter((f) => f.anon_exec).map((f) => f.proname);

    out.icms_tables_present = (
      await q(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and relname = any($1)`, [
        ["users", "transactions", "seals", "incidents", "vendors", "whitelists", "duty_records", "team_rosters", "bay_board", "caterlink_station_capabilities", "caterlink_whitelist"],
      ])
    ).map((r) => r.relname);
    out.users_columns = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='users' order by ordinal_position`)).map((r) => r.column_name);
    out.users_table_exists = (await q(`select to_regclass('public.users') is not null e`))[0].e;
    out.users_row_count = out.users_table_exists ? (await q(`select count(*)::int n from public.users`))[0].n : null;
    out.caterlink_capabilities = await q(`select s.code, c.can_scan from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code`);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(out, null, 2));
  console.log("\nRead-only: no record was created, modified or deleted.");
}

main().catch((err) => {
  console.error("FATAL:", String(err.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"));
  process.exit(1);
});
