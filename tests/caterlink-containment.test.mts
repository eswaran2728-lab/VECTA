import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const read = (p: string) => fs.readFileSync(p, "utf8");
const MIG = "supabase/migrations/20261108000001_caterlink_fail_closed_containment.sql";
const sql = read(MIG).replace(/--.*$/gm, "");

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mts)$/.test(e.name) ? [p] : [];
  });
const APP = ["app", "lib", "components"].flatMap(walk).filter((f) => !f.endsWith("database.types.ts"));

test("skip_part_d and raise_caterlink_incident_secure are fail-closed stubs that no role can execute", () => {
  for (const [fn, args] of [["skip_part_d", "uuid, text"], ["raise_caterlink_incident_secure", "uuid, text, text, text, text"]] as const) {
    const body = new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`).exec(sql)![1];
    assert.match(body, /raise exception 'Not available\.'/, `${fn} only raises`);
    assert.doesNotMatch(body, /current_user_role|insert into|update public|auth\.uid/i, `${fn} has no legacy role text, no write`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(${args}\\) from public, anon, authenticated, service_role;`), `${fn}: every role loses EXECUTE`);
    assert.doesNotMatch(sql, new RegExp(`grant[^;]*public\\.${fn}`), `${fn} is never granted`);
  }
});

test("the Part B automatic escalation does not depend on the closed incident RPC", () => {
  const partB = read("supabase/migrations/20261107000001_caterlink_part_b_checkpoint.sql");
  assert.doesNotMatch(partB, /raise_caterlink_incident_secure|skip_part_d/);
  assert.match(partB, /caterlink_checkpoint_escalate_internal/);
});

test("the receipt locks the row, then gates on the final-step state of the existing state machine, before any write", () => {
  const fn = /create or replace function public\.confirm_caterlink_destination_receipt_secure\([\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(sql)![1];
  const lock = fn.indexOf("for update");
  const gate = fn.indexOf("caterlink_receipt_ready_statuses");
  const firstWrite = fn.search(/insert into public\.caterlink_checkpoint_hub|update public\.transactions/);
  assert.ok(lock > 0 && gate > lock && firstWrite > gate, "lock < state gate < first write");
  const ready = /caterlink_receipt_ready_statuses\(p_direction text, p_route text\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(sql)![1];
  // derived from lib/icms/workflow.ts: the status each route's FINAL step is waiting on
  const workflow = read("lib/icms/workflow.ts");
  assert.match(workflow, /part: "part_hub",[\s\S]*?requiredStatus: "INFLIGHT_POST_APPROVED",[\s\S]*?finalizes: true/);
  assert.match(workflow, /part: "part_d",[\s\S]*?requiredStatus: "AIRPORT_POST_APPROVED",[\s\S]*?finalizes: true/);
  assert.match(ready, /'HUB', 'MAINTENANCE'\) then array\['INFLIGHT_POST_APPROVED'\]/);
  assert.match(ready, /array\['AIRPORT_POST_APPROVED', 'POST6_APPROVED'\]/);
  assert.doesNotMatch(ready, /'CREATED'/, "CREATED is never a receivable state");
  assert.match(sql, /list_caterlink_pending_receipts_secure[\s\S]*caterlink_receipt_ready_statuses\(t\.direction, t\.route\)/, "the list uses the same rule");
});

test("the containment is one additive migration: later than every earlier one and the earlier files are unchanged on disk", () => {
  const files = fs.readdirSync("supabase/migrations").filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  const at = files.indexOf(path.basename(MIG));
  assert.ok(at > 0, "the containment migration exists");
  assert.equal(files[at - 1], "20261107000001_caterlink_part_b_checkpoint.sql", "it directly follows the Part B migration");
  assert.equal(files.filter((f) => f.startsWith("20261108")).length, 1);
  // the version is unique
  assert.equal(new Set(files.map((f) => f.slice(0, 14))).size, files.length, "no version collision");
  // the Part B migration (the previous latest) keeps its frozen hash
  const partB = crypto.createHash("sha256").update(read("supabase/migrations/20261107000001_caterlink_part_b_checkpoint.sql").replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(partB, "2b439edd6480d268ff75e26877c174ea67aa431ba50a05a62970a3f18fa67e7c");
});

test("no application code calls the closed RPCs; no Skip control and no general Raise Incident control exists", () => {
  for (const f of APP) {
    const src = read(f);
    assert.doesNotMatch(src, /rpc\(\s*["']skip_part_d["']/, `${f} must not call skip_part_d`);
    assert.doesNotMatch(src, /rpc\(\s*["']raise_caterlink_incident_secure["']/, `${f} must not call raise_caterlink_incident_secure`);
    assert.doesNotMatch(src, /skipPartD|SkipPartDForm|reportIncident|IncidentForm/, `${f} must not reference the removed Skip / incident controls`);
  }
  assert.ok(!fs.existsSync("app/(icms)/icms/transactions/[id]/skip-part-d/skip-part-d-form.tsx"));
  assert.ok(!fs.existsSync("app/(icms)/icms/transactions/[id]/incident/incident-form.tsx"));
});

test("regression: no active VECTA caller queries the nonexistent legacy incidents table", () => {
  const offenders = APP.filter((f) => /\.from\(\s*["']incidents["']\s*\)/.test(read(f)));
  assert.deepEqual(offenders, [], "only the canonical caterlink_incidents table may be read");
  assert.doesNotMatch(read("lib/icms/actions/transactions.ts"), /\.from\("incidents"\)|\.from\("incident_photos"\)/);
  // the offline sync accepts Part B only; the legacy kinds that wrote to absent tables are rejected as unknown
  const sync = read("app/api/icms/sync/route.ts");
  assert.match(sync, /const ACTIONS = \{\s*part_b: completePartB,\s*\} as const;/);
});

test("Part Hub keeps redirecting to the destination receipt (commit 599c290 preserved)", () => {
  assert.match(read("app/(icms)/icms/transactions/[id]/part-hub/page.tsx"), /redirect\("\/avsec\/caterlink\/receipt"\)/);
  for (const f of ["app/page.tsx", "app/(avsec)/avsec/admin/alerts/page.tsx", "lib/avsec/duty/handover-queries.ts", "lib/dashboard/flight-detail.ts", "lib/dashboard/needs-your-action.ts"]) {
    assert.match(read(f), /\.from\("caterlink_incidents" as never\)/, `${f} reads canonical incidents`);
  }
});

test("the overdue catering indicator is suppressed (SLA configuration pending), not shown as zero", () => {
  const src = read("lib/dashboard/needs-your-action.ts");
  assert.match(src, /export const CATERING_OVERDUE_SLA_STATUS = "SLA configuration pending"/);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /status_entered_at|Catering Movement Overdue|CATERING_OVERDUE_HOURS/);
});

test("supplement (behaviour is proven by the database suites): the receipt binds the destination from the movement and never rewrites it", () => {
  const fn = /create or replace function public\.confirm_caterlink_destination_receipt_secure\([\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(sql)![1];
  const bind = fn.indexOf("v_expected <> p_station_code");
  const firstWrite = fn.search(/insert into public\.caterlink_checkpoint_hub|update public\.transactions/);
  assert.ok(bind > 0 && bind < firstWrite, "the destination equality check precedes every write");
  assert.match(fn, /caterlink_expected_receiving_station\(v_tx\.hub_destination, v_tx\.destination_station_id\)/);
  assert.doesNotMatch(fn, /destination_station_id\s*=\s*v_station_id/, "a caller-supplied station never overwrites the trusted destination");
  assert.match(fn, /v_expected is null/, "no trusted destination fails closed");
  const list = /create or replace function public\.list_caterlink_pending_receipts_secure\([\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(sql)![1];
  assert.match(list, /caterlink_expected_receiving_station\(t\.hub_destination, t\.destination_station_id\) = p_station_code/, "the list uses the same binding");
});

test("frozen hashes: the staging runner pins exactly the eight forward migrations, and the files match", () => {
  const runner = fs.readFileSync("scripts/staging/apply-containment-migration.mjs", "utf8");
  const entries = [...runner.matchAll(/\{ version: "(\d{14})", name: "([a-z_]+)", sha256: "([0-9a-f]{64})" \}/g)];
  assert.deepEqual(entries.map((e) => e[1]), ["20261108000001", "20261109000001", "20261110000001", "20261111000001", "20261112000001", "20261113000001", "20261114000001", "20261115000001"]);
  for (const [, version, name, sha] of entries) {
    const text = fs.readFileSync(`supabase/migrations/${version}_${name}.sql`, "utf8").replace(/\r\n/g, "\n");
    assert.equal(crypto.createHash("sha256").update(text).digest("hex"), sha, `${version}_${name} differs from its frozen hash`);
  }
  assert.match(runner, /PRE_COUNT = 83/);
  assert.match(runner, /LAST_PRE = "20261107000001"/);
  const all = fs.readdirSync("supabase/migrations").filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();
  assert.equal(new Set(all.map((f) => f.slice(0, 14))).size, all.length, "no migration version collision");
  assert.deepEqual(all.filter((f) => f.slice(0, 14) > "20261107000001").map((f) => f.slice(0, 14)), ["20261108000001", "20261109000001", "20261110000001", "20261111000001", "20261112000001", "20261113000001", "20261114000001", "20261115000001"], "migration order");
});
