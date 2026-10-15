import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Supabase returns { error } instead of throwing. A write or secure-RPC call whose result is not inspected reports success while nothing
 * happened. Every unassigned write in application code must be either fixed or listed here as deliberate best-effort work (cleanup,
 * telemetry, a preference) with the reason.
 */
const BEST_EFFORT: Record<string, string> = {
  "app/api/wois/chat/route.ts": "assistant message logging; the answer is already produced",
  "lib/avsec/attachments/actions.ts": "storage clean-up of an already-rejected upload",
  "lib/avsec/admin/sheetSyncActions.ts": "queue bookkeeping for an external sheet sync",
  "lib/avsec/reports/drafts.ts": "draft clean-up after the report was saved",
  "lib/icms/completed-form-pdf.ts": "post-commit PDF job bookkeeping retried by the durable queue",
  "lib/icms/actions/language.ts": "display-language preference",
  "lib/phase8/investigation-extras.ts": "storage clean-up of a rolled-back evidence upload",
  "lib/phase8/sat.ts": "storage clean-up of a rolled-back report upload",
  "lib/storage/adapter.ts": "storage clean-up helper",
};

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (["node_modules", ".next", ".git"].includes(e.name)) return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

test("no unlisted application code ignores the result of a database write or secure RPC", () => {
  const re = /^[ \t]*await\s+(\w+)\s*(?:\n\s*)?\.from\(([^)]*)\)\s*(?:\n\s*)?\.(insert|update|upsert|delete)\(|^[ \t]*await\s+\w+\.rpc\(/gm;
  const offenders: string[] = [];
  for (const f of [...walk("app"), ...walk("lib")]) {
    const rel = f.split(path.sep).join("/");
    if (BEST_EFFORT[rel] || rel.endsWith("database.types.ts")) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(offenders, []);
});

test("deactivating a user reports a failed or non-applied update instead of success", () => {
  const src = fs.readFileSync("lib/avsec/admin/actions.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function deactivateUser("), src.indexOf("const REPORT_TABLES"));
  assert.match(fn, /\.update\(\{ status: "deactivated" \}\)[\s\S]{0,120}\.select\("id"\)/);
  assert.match(fn, /if \(error\)/);
  assert.match(fn, /data\.length === 0/);
});

test("zone activation toggles and whitelist approve/activate/expiry changes surface a failure", () => {
  const zone = fs.readFileSync("lib/avsec/duty/zone-actions.ts", "utf8");
  const toggle = zone.slice(zone.indexOf("export async function toggleZoneActive("));
  assert.match(toggle, /const \{ error \} = await supabase\.from\("duty_zones"\)\.update/);
  assert.match(toggle, /if \(error\)/);
  const wl = fs.readFileSync("lib/icms/actions/whitelists.ts", "utf8");
  for (const name of ["approveWhitelistEntry", "activateWhitelistEntry", "updatePassExpiry"]) {
    const fn = wl.slice(wl.indexOf(`export async function ${name}(`));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /const \{ error \} = await supabase\.rpc\(/, `${name} inspects the RPC result`);
    assert.match(body, /if \(error\)[\s\S]*redirect\(/, `${name} redirects with a failure notice`);
  }
  const page = fs.readFileSync("app/(icms)/icms/admin/whitelists/page.tsx", "utf8");
  assert.match(page, /searchParams: Promise<\{[^}]*error\?: string/);
  assert.match(page, /role="alert"/);
});

test("bay-board linkage failures are logged, not swallowed", () => {
  const src = fs.readFileSync("lib/avsec/reports/actions.ts", "utf8");
  assert.equal((src.match(/bay_board linkage failed/g) ?? []).length, 3);
});
