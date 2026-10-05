#!/usr/bin/env node
// Read-only: per public table, authenticated/anon privileges and policy predicates (SQL text only).
import { createRequire } from "node:module";
import path from "node:path";
import { buildVerifiedClientConfig } from "./lib/db-tls.mjs";
const require = createRequire(import.meta.url);
let pg; try { pg = require("pg"); } catch { pg = require(path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg")); }
const dbUrl = process.env.STAGING_DATABASE_URL;
if (!dbUrl || !new URL(dbUrl).hostname.concat(new URL(dbUrl).username).includes("ddlctzbnqewubltcavkh")) throw new Error("not the approved staging project");
const cfg = buildVerifiedClientConfig(dbUrl);
const c = new pg.Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  const t = await c.query(`
    select c.relname t,
      (select count(*)::int from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) cols,
      (select count(*)::int from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and has_column_privilege('authenticated', c.oid, a.attnum, 'select')) sel_cols,
      has_table_privilege('authenticated',c.oid,'select') tsel, has_table_privilege('authenticated',c.oid,'insert') ins,
      has_table_privilege('authenticated',c.oid,'update') upd, has_table_privilege('authenticated',c.oid,'delete') del,
      has_table_privilege('anon',c.oid,'select,insert,update,delete') anon
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by 1`);
  const p = await c.query(`select tablename t, policyname n, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='public' order by 1,2`);
  console.log(JSON.stringify({ tables: t.rows, policies: p.rows }));
  await c.query("ROLLBACK");
} finally { await c.end(); }
