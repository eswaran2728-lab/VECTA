# Phase 6 database-integration validation

Applies the **real** migration chain (`avsec/0001`-`0026`, the two
structural undated migrations, every dated root migration through
Phase 2-6) to a disposable, synthetic-data Postgres instance, then runs
`supabase/tests/phase6_integration_harness.sql`'s executable scenarios
against it. This is genuine SQL execution — not a re-run of the static
source-text tests in `tests/phase6-secure-report-access.test.mts`.

## What runs the database

[`@electric-sql/pglite`](https://pglite.dev/) — a real, embedded
PostgreSQL 18 engine compiled to WASM, not a reimplementation or mock.
It runs entirely in-process via Node, needs no server, no Docker, and no
network access. Version is pinned in `package.json`/`package-lock.json`.

## Setup

```bash
cd supabase/tests/integration
npm install
```

## Run

```bash
node migrate.mjs                    # applies the migration chain, prints a manifest
node run_harness.mjs                # runs the integration harness, prints scenario/assertion results
node verify_export_isolation.mjs    # explicit re-check of the export_reports_secure() fix (round 10):
                                     # sequential different identities on one connection stay isolated,
                                     # in both their export results AND their audit records
```

or, both in sequence:

```bash
npm test
```

`migrate.mjs` builds a persistent `./pgdata` directory (gitignored) —
delete it (or delete `progress.json`) to rebuild from an empty database.
`run_harness.mjs` always works on a throwaway copy
(`./pgdata_harness_run`, also gitignored) so it can be re-run repeatedly
without re-running `migrate.mjs`, and so a failed run never contaminates
the post-migration snapshot.

## What `migrate.mjs` reports

A manifest classifying every migration file as:

- **UNCHANGED** — applied byte-for-byte as written, no adaptation of any
  kind.
- **ADAPTED** — applied with a documented platform-compatibility shim
  (see `PRE_SHIMS`/`stripUnsupportedExtensions` in `migrate.mjs`) or an
  unavailable-extension line stripped. The migration's own SQL text is
  still applied unmodified in every case — adaptations only add
  prerequisite objects immediately before a file, or remove a `create
  extension` line PGlite cannot satisfy.
- **FAILED** — the migration apply stopped here (should not currently
  occur; if it does, that is a real, reportable regression).
- **EXCLUDED** — never attempted at all. Every excluded file is listed
  by name with its reason (ICMS-only module content, one-off data/demo
  scripts against real accounts, etc.) — see the `EXCLUDED` object in
  `migrate.mjs`.

**Every platform-compatibility stub and synthetic schema addition is
named explicitly** in `migrate.mjs` (`00_platform_stubs.sql` for
generic Supabase platform primitives — `auth.*`, `storage.*`, `cron.*`,
`net.*`, roles; `PRE_SHIMS` for two specific, documented baseline gaps:
an ICMS `public.users` placeholder table, and a reconstructed
`public.user_registration_requests` table that Phase 4 depends on but
that no migration in this repository's history actually creates).
**None of these stub, replace, or weaken any Phase 6 authorization or
application function under test** — every Phase 6 function, RLS policy,
grant, and trigger runs as the real, unmodified migration SQL against
these platform primitives.

## What `run_harness.mjs` reports

Each top-level scenario block from the harness file (`-- SCENARIO N:
...` through the next marker), individually executed and reported as
`OK` or `FAIL`, with the count of `pg_temp.assert()` calls in that block
(a scenario reporting `OK` means every one of its assertions passed —
`pg_temp.assert()` itself raises on any failing condition, so a
completed block and a fully-passed block are the same fact).

## Known limitations (by design, not oversights)

- **Scenarios 12 and 26** (the harness file's two genuine cross-
  transaction/cross-connection concurrency tests) are **not** part of
  the single-connection PGlite executable `begin;...rollback;` block.
  However, with native PostgreSQL (e.g. the local portable PG17 binary in `./pg17`),
  both Scenarios 12 and 26 are executed automatically via separate concurrent connections
  with kernel-level lock inspection by running:
  ```bash
  npm run verify-concurrency:native
  ```
  or the full native test suite:
  ```bash
  npm run test:native
  ```
- This validates against **synthetic fixture data only**, never
  production data, production credentials, or a shared staging
  environment.

