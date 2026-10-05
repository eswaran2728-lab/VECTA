import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildVerifiedClientConfig } from "../scripts/staging/lib/db-tls.mjs";

const DIR = path.resolve(import.meta.dirname, "..", "scripts", "staging");

test("staging scripts never disable TLS certificate verification", () => {
  for (const f of fs.readdirSync(DIR, { recursive: true }) as string[]) {
    if (!f.endsWith(".mjs")) continue;
    assert.ok(!/rejectUnauthorized\s*:\s*false/.test(fs.readFileSync(path.join(DIR, f), "utf8")), `${f} must not set rejectUnauthorized: false`);
  }
});

test("buildVerifiedClientConfig enforces verification and strips URL sslmode overrides", () => {
  const cfg = buildVerifiedClientConfig("postgres://u:p@host.example.test:5432/postgres?sslmode=no-verify&application_name=x");
  assert.equal(cfg.ssl.rejectUnauthorized, true);
  assert.ok(!cfg.connectionString.includes("sslmode"));
  assert.ok(cfg.connectionString.includes("application_name=x"));
});
