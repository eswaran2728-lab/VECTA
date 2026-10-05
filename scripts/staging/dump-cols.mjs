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
  const r = await c.query(`select table_name t, string_agg(column_name, ',' order by ordinal_position) cols from information_schema.columns where table_schema='public' and table_name = any($1) group by 1`, [process.argv.slice(2)]);
  for (const x of r.rows) console.log(x.t + ": " + x.cols);
  await c.query("ROLLBACK");
} finally { await c.end(); }
