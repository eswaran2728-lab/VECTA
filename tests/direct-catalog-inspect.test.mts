import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import child_process from "node:child_process";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";
import { runDirectCatalogInspection } from "../scripts/staging/direct-catalog-inspect.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "staging", "direct-catalog-inspect.mjs");

test("direct catalog inspector: rejects forbidden production project reference", () => {
  assert.throws(() => {
    child_process.execFileSync(
      process.execPath,
      [SCRIPT_PATH],
      {
        env: {
          ...process.env,
          STAGING_DATABASE_URL: "postgres://postgres:secret@db.zsxneokqulktgnccxgkz.supabase.co:5432/postgres"
        },
        encoding: "utf8",
        stdio: "pipe"
      }
    );
  }, (err: any) => {
    const stderr = err.stderr || err.stdout || "";
    return stderr.includes("FATAL: FORBIDDEN PRODUCTION PROJECT REF DETECTED");
  });
});

test("direct catalog inspector: rejects unapproved project reference", () => {
  const result = child_process.spawnSync(
    process.execPath,
    [SCRIPT_PATH],
    {
      env: {
        ...process.env,
        STAGING_DATABASE_URL: "postgres://postgres:secret@db.randomproject12345.supabase.co:5432/postgres"
      },
      encoding: "utf8"
    }
  );

  assert.ok(result.stdout.includes("Notice: Target host 'db.randomproject12345.supabase.co' does not contain approved staging ref 'ddlctzbnqewubltcavkh'"));
  assert.ok(result.stdout.includes("OPERATOR CONFIGURATION INSTRUCTIONS"));
});

test("direct catalog inspector: executes all 11 catalog inspection queries against database", async () => {
  const db = new PGlite();
  // Set up schema and sample tables/views/triggers
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (
      version text primary key,
      inserted_at timestamp with time zone default clock_timestamp()
    );
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20240101000000');

    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE storage.buckets (
      id text primary key,
      name text not null,
      public boolean default false,
      created_at timestamptz default clock_timestamp()
    );
    INSERT INTO storage.buckets (id, name, public) VALUES ('b1', 'announcements', true);

    CREATE SCHEMA IF NOT EXISTS cron;
    CREATE TABLE cron.job (
      jobid bigint primary key,
      schedule text,
      command text,
      active boolean default true
    );

    CREATE TABLE public.profiles (
      id uuid primary key,
      name text,
      status text
    );

    CREATE OR REPLACE FUNCTION public.sample_fn() RETURNS text LANGUAGE sql AS $$ SELECT 'ok' $$;
  `);

  // Wrap db query to mimic pg client interface
  const dbAdapter = {
    query: async (sql: string) => {
      const res = await db.query(sql);
      return { rows: res.rows };
    }
  };

  // Run inspection queries without throwing
  await runDirectCatalogInspection(dbAdapter);
  await db.close();
});
