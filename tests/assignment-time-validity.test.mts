import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveCanonicalAccess, assignmentsFromRpcRows } from "../lib/auth/canonical-access.ts";
import { buildNavModel } from "../lib/dashboard/nav-capabilities.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIG = path.join(ROOT, "supabase", "migrations");

/** Latest definition (by migration order) of every public function. */
function latestFunctionBodies(): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  for (const f of fs.readdirSync(MIG).filter((n) => /^2026\d{10}_.*\.sql$/.test(n)).sort()) {
    const sql = fs.readFileSync(path.join(MIG, f), "utf8");
    const parts = sql.split(/create (?:or replace )?function /i).slice(1);
    for (const part of parts) {
      const name = part.match(/^public\.(\w+)/)?.[1];
      if (!name) continue;
      const first = part.indexOf("$function$");
      const end = first >= 0 ? part.indexOf("$function$", first + 10) : -1;
      out.set(name, { file: f, body: end > 0 ? part.slice(0, end) : part.slice(0, 6000) });
    }
  }
  return out;
}

// Assignment-MANAGEMENT functions act on one named assignment row (create / transfer / deactivate / validate); they are not an
// "is this caller authorized right now" decision, so an effective-date window does not apply to them.
const MANAGEMENT_FUNCTIONS = new Set([
  "approve_registration_request",
  "deactivate_assignment",
  "initiate_cross_entity_transfer",
  "is_authorized_admin_for_assignment",
  "set_updated_at_user_role_assignments",
  "transfer_assignment_same_entity",
]);

test("every database function that reads role assignments applies the effective-date window (starts_at)", () => {
  const offenders: string[] = [];
  for (const [name, { file, body }] of latestFunctionBodies()) {
    if (!/user_role_assignments/i.test(body)) continue;
    if (MANAGEMENT_FUNCTIONS.has(name)) continue;
    if (!/starts_at/i.test(body)) offenders.push(`${name} (${file})`);
  }
  assert.deepEqual(offenders, [], "an authorization function reads assignments without checking starts_at");
});

test("every database function that reads role assignments also honours revocation and end date", () => {
  const offenders: string[] = [];
  for (const [name, { file, body }] of latestFunctionBodies()) {
    if (!/user_role_assignments/i.test(body) || MANAGEMENT_FUNCTIONS.has(name)) continue;
    if (!/revoked_at/i.test(body) || !/ends_at/i.test(body)) offenders.push(`${name} (${file})`);
  }
  assert.deepEqual(offenders, []);
});

test("the active-assignment RPC itself enforces approved profile, revocation, start and end", () => {
  const body = latestFunctionBodies().get("get_my_active_role_assignments")!.body;
  for (const needle of ["p.status = 'approved'", "ura.revoked_at is null", "ura.starts_at <= now()", "ura.ends_at is null or ura.ends_at > now()", "rd.is_active"]) {
    assert.ok(body.includes(needle), needle);
  }
});

test("application: a profile whose assignments the RPC did not return (future / expired / revoked / pending) has NO access and NO navigation", () => {
  // The RPC returns nothing for those states, so the app sees an empty row set.
  const access = deriveCanonicalAccess(assignmentsFromRpcRows([]));
  assert.equal(access.hasAssignment, false);
  assert.deepEqual(access.roleCodes, []);
  const model = buildNavModel({ roleCodes: access.roleCodes });
  assert.equal(model.kind, "none");
  assert.deepEqual(model.groups, []);
  assert.deepEqual(model.tabs, []);
});

test("application: direct assignment-table reads in TS apply the same window", () => {
  const absence = fs.readFileSync(path.join(ROOT, "lib/avsec/duty/absence-actions.ts"), "utf8");
  assert.match(absence, /\.lte\("starts_at", nowIso\)/);
  const authority = fs.readFileSync(path.join(ROOT, "lib/super-admin/authority.ts"), "utf8");
  assert.match(authority, /startsAt: a\.starts_at/);
});

test("staging fixtures: the future-dated test assignment cannot silently become active", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/staging/provision-test-accounts.mjs"), "utf8");
  const m = src.match(/future_dated: \{ starts_at: new Date\(\+now \+ ([^)]*)\)/);
  assert.ok(m, "future_dated timing found");
  assert.doesNotMatch(m![1], /^DAY$/, "a one-day offset expires into an ACTIVE assignment after a day (the audit's 'future' account was provisioned 2026-10-05)");
  assert.match(m![1], /3650|365 \* /);
});
