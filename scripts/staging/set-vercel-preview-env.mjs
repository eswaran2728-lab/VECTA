#!/usr/bin/env node
// Sets the Preview-scope environment of the dedicated Vercel preview project from the existing local
// configuration WITHOUT printing, logging or committing any value. Values travel to the Vercel CLI over stdin.
//
// Guards: the Supabase URLs must resolve to the approved staging project; the production reference must not
// appear in any value being sent; the linked Vercel project must be the dedicated preview project.
//
// Usage: node scripts/staging/set-vercel-preview-env.mjs [--app-url=<https://preview-url>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const APPROVED_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_REF = "zsxneokqulktgnccxgkz";
const PROJECT = "vecta-staging-preview";
const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const appUrl = args.find((a) => a.startsWith("--app-url="))?.split("=").slice(1).join("=");

const link = JSON.parse(fs.readFileSync(path.join(root, ".vercel", "project.json"), "utf8"));
if (link.projectName && link.projectName !== PROJECT) throw new Error("The linked Vercel project is not the dedicated preview project.");

function parseEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const local = parseEnv(path.join(root, ".env.local"));

const refOf = (u) => new URL(u).hostname.split(".")[0];
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
  if (!local[k]) throw new Error(`${k} is missing locally`);
  if (refOf(local[k]) !== APPROVED_REF) throw new Error(`${k} does not resolve to the approved staging project`);
}
const secret = local.SUPABASE_SECRET_KEY || local.SUPABASE_SERVICE_ROLE_KEY;
if (!secret) throw new Error("No server-side Supabase secret is configured locally");
if (!local.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw new Error("The publishable key is missing locally");

// name -> [value, sensitive]. NEXT_PUBLIC_* are build-time browser values and are NOT sensitive.
const vars = {
  NEXT_PUBLIC_SUPABASE_URL: [local.NEXT_PUBLIC_SUPABASE_URL, false],
  NEXT_PUBLIC_SUPABASE_ANON_KEY: [local.NEXT_PUBLIC_SUPABASE_ANON_KEY, false],
  SUPABASE_URL: [local.SUPABASE_URL, false],
  SUPABASE_SECRET_KEY: [secret, true],
  SUPABASE_SERVICE_ROLE_KEY: [secret, true], // read by the admin server actions; same staging secret
  QR_TOKEN_SECRET: [crypto.randomBytes(48).toString("base64url"), true], // new, staging-only
};
if (appUrl) {
  if (!/^https:\/\//.test(appUrl)) throw new Error("--app-url must be https");
  vars.NEXT_PUBLIC_APP_URL = [appUrl, false];
}
for (const [name, [value]] of Object.entries(vars)) {
  if (value.includes(FORBIDDEN_REF)) throw new Error(`${name} contains the production reference`);
}

for (const [name, [value, sensitive]] of Object.entries(vars)) {
  const r = spawnSync("npx", ["vercel", "env", "add", name, "preview", "--yes", "--force", sensitive ? "--sensitive" : "--no-sensitive", "--scope", "eswaran1"], {
    cwd: root, input: value, encoding: "utf8", shell: true,
  });
  console.log(`${r.status === 0 ? "SET " : "FAIL"} ${name} (preview, ${sensitive ? "sensitive" : "plain"})`);
  if (r.status !== 0) {
    console.log(String(r.stderr || r.stdout).replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]").slice(0, 300));
    process.exit(1);
  }
}
