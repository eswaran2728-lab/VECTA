#!/usr/bin/env node
// Read-only: prints policy predicates (SQL text only, no row data) that reference legacy identity helpers.
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
  const rx = "is_approved_management|current_role_name|current_role_rank|is_monitor_or_above|current_station|current_team|current_status|role_rank|submitter_role_rank|ops_group|unified_role|profiles";
  const r = await c.query(`select tablename, policyname, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='public' and (coalesce(qual,'') ~ $1 or coalesce(with_check,'') ~ $1) order by 1,2`, [rx]);
  const names = ["is_approved_management", "current_role_name", "current_role_rank", "is_monitor_or_above", "current_station", "current_team", "submitter_role_rank", "role_rank"];
  const f = await c.query(
    "select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') and not (p.proname = any($1)) and exists (select 1 from unnest($1::text[]) h where position(h in p.prosrc) > 0) order by 1",
    [names],
  );
  console.log(JSON.stringify({ policies: r.rows, functions: f.rows }));
  await c.query("ROLLBACK");
} finally { await c.end(); }
