import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-expect-error plain .mjs tooling modules
import { DUTY_LABELS, dbClock, inactiveDutyLabels } from "../scripts/staging/lib/uat-duty.mjs";
import { isRostered } from "../lib/auth/role-capabilities.ts";

const read = (p: string) => fs.readFileSync(p, "utf8");
const FIX = read("scripts/staging/uat-fixtures.mjs");
const UAT = read("scripts/staging/hosted-uat.mjs");
const PRE = read("scripts/staging/uat-preflight.mjs");

test("duty fixture accounts are exactly the rostered review accounts that have a station (16), all disposable review labels", () => {
  assert.equal(DUTY_LABELS.length, 16);
  assert.equal(new Set(DUTY_LABELS).size, 16);
  for (const l of ["aso", "aso-jhb", "aso-kul", "aso-kch-receipt", "aso-bki-receipt", "aso-no-caterlink", "sso", "so", "dse", "sat_aso", "profiling_so", "profiling_aso"]) assert.ok(DUTY_LABELS.includes(l), l);
  assert.ok(!DUTY_LABELS.some((l) => /^(neg-|caterlink-|super_admin|maa_|aax_|operation_manager|main_enforcement)/.test(l)), "no negative-state, external, leadership or management account");
  const roleOf = (l: string) => l.replace(/-(kul|jhb|no-caterlink|kch-receipt|bki-receipt)$/, "");
  assert.ok(DUTY_LABELS.every((l) => isRostered(roleOf(l))), "every fixture account is a rostered role");
});

test("fixture time comes from the staging database clock, never the local machine", () => {
  assert.match(read("scripts/staging/lib/uat-duty.mjs"), /now\(\) at time zone 'Asia\/Kuala_Lumpur'/);
  assert.doesNotMatch(FIX, /new Date\(|Date\.now\(\)/, "no local clock in the fixture tool");
  assert.match(FIX, /const clock = await dbClock\(client\)/);
});

test("create-duty: window check, one current-date row per account, collision-safe, idempotent, verified through the gate predicate", () => {
  assert.match(FIX, /not enough time before Malaysia midnight/);
  assert.match(FIX, /max-run-minutes/);
  assert.match(FIX, /already holds duty fixtures/);
  assert.match(FIX, /refusing to collide/);
  assert.match(FIX, /inactiveDutyLabels\(client, ledger\.duty, manifest\)/);
  assert.equal((FIX.match(/insert into public\.duty_records/g) ?? []).length, 1, "a single insert statement");
  assert.doesNotMatch(FIX, /interval '1 day'|tomorrow|\+ ?1 day/i, "no simultaneous tomorrow rows");
  assert.match(FIX, /handover_notes = \$2 returning id/, "cleanup deletes only recorded, still-tagged rows");
});

test("notifications: new run id every time, refuse reuse, unread proved at creation and again before the mark-read test", () => {
  assert.match(FIX, /never reuse a consumed notification/);
  assert.match(FIX, /is not unread immediately after creation/);
  assert.match(UAT, /sees their own fixture notification \(unread\)/);
  assert.match(UAT, /cannot mark .* notification read \(owner-scoped\)/);
  assert.match(UAT, /cannot read .* notification/);
  assert.match(PRE, /ALL are unread/);
});

test("hosted UAT: gate before duty, controlled creation, window guards, exit code 3 when inconclusive, zero-inconclusive requirement", () => {
  assert.ok(UAT.indexOf("sectionDutyGate(browser)") < UAT.indexOf("createDutyFixtures();"));
  assert.ok(UAT.indexOf("createDutyFixtures();") < UAT.indexOf('run("auth+routes"'));
  assert.match(UAT, /assertDutyWindow\("immediately before the station section"\)/);
  assert.match(UAT, /process\.exit\(3\)/);
  assert.match(UAT, /not recreated during a run|NOT recreated during a run/);
  assert.match(UAT, /zero route checks remained inconclusive/);
  assert.match(UAT, /active duty grants no authority over/);
});

test("network diagnostics are sanitized, reads are retried once, writes never are, recovered events are reported not hidden", () => {
  const block = UAT.slice(UAT.indexOf('page.on("requestfailed"'), UAT.indexOf('page.on("pageerror"'));
  assert.match(block, /u\.pathname\.slice\(0, 120\)/, "pathname only");
  const literal = /const d = \{([^}]*)\};/.exec(block)![1];
  assert.deepEqual([...literal.matchAll(/(\w+):/g)].map((m) => m[1]), ["section", "method", "host", "path", "type", "attempt", "at", "outcome"], "exactly the sanitized fields (plus the shorthand failure text)");
  assert.doesNotMatch(literal, /search|href|req\.url|headers|postData|email|token/i);
  assert.doesNotMatch(block, /d\.(url|headers|query|body)\s*=/);
  assert.match(block, /req\.method\(\) !== "GET" && req\.method\(\) !== "HEAD"/);
  assert.match(block, /failed \(write, not retried\)/);
  assert.match(block, /recovered \(retry HTTP/);
  assert.match(UAT, /no unrecovered network failure/);
  for (const k of ["section", "method", "host", "path", "type", "failure", "attempt", "at"]) assert.match(block, new RegExp(`\\b${k}\\b`), k);
});

test("preflight baseline: the expected migration count and latest version are explicit and tied to the guarded runner", () => {
  const base = read("scripts/staging/lib/expected-baseline.mjs");
  const containment = read("scripts/staging/apply-containment-migration.mjs");
  assert.equal([...containment.matchAll(/\{ version: "(\d{14})", name:/g)].length, 9, "nine security migrations: 83 + 9 = 92");
  const lastRunnerVersion = read("scripts/staging/apply-child-policy-fix-migration.mjs").match(/version:\s*"(\d{14})"/)?.[1];
  assert.match(base, new RegExp(`EXPECTED_LATEST_MIGRATION = "${lastRunnerVersion}"`), "latest version equals the guarded child-policy-fix migration");
  assert.match(base, /EXPECTED_MIGRATION_COUNT = 105;/, "104 prior migrations plus the child-policy-fix migration");
  assert.ok(PRE.includes("EXPECTED_MIGRATION_COUNT") && PRE.includes("EXPECTED_LATEST_MIGRATION") && !/82/.test(PRE), "preflight uses the explicit baseline, no literal 82");
});

test("preflight: production absent, staging target, expected migrations, one fresh set, nothing else running", () => {
  for (const needle of ["production reference absent", "approved staging project only", "migrations ending at", "ALL are unread", "no other UAT", "no disposable PostgreSQL", "only in scripts/tests/docs", "none from any other run"]) assert.ok(PRE.includes(needle), needle);
  assert.doesNotMatch(PRE, /\.query\(\s*["'`]\s*(insert|update|delete)/i, "preflight is read-only");
});

test("dbClock and inactiveDutyLabels behave as specified (fake database client)", async () => {
  const calls: string[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push(sql.trim().split(/\s+/)[0]);
      if (/extract\(epoch/.test(sql)) return { rows: [{ now_utc: "2026-10-13 03:00:00+00", my_date: "2026-10-13", seconds_left: 18000 }], rowCount: 1 };
      if (/from public\.duty_records/.test(sql)) return { rows: [], rowCount: params && params[0] === "uid-ok" ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  assert.deepEqual(await dbClock(client), { nowUtc: "2026-10-13 03:00:00+00", myDate: "2026-10-13", secondsLeft: 18000 });
  const manifest = [{ label: "a", authUserId: "uid-ok" }, { label: "b", authUserId: "uid-bad" }];
  assert.deepEqual(await inactiveDutyLabels(client, [{ label: "a" }, { label: "b" }], manifest), ["b"]);
  assert.ok(calls.filter((c) => c === "BEGIN").length === 2 && calls.filter((c) => c === "ROLLBACK").length === 2, "each probe runs in a rolled-back transaction");
});

test("sign-in helper waits for the real fields, submits once per attempt, is bounded and records only sanitized stages", () => {
  const body = UAT.slice(UAT.indexOf("async function login("), UAT.indexOf("const pathOf = "));
  assert.match(body, /waitForSelector\('input\[name="email"\]', \{ state: "visible"/);
  assert.match(body, /waitForSelector\('input\[name="password"\]', \{ state: "visible"/);
  assert.equal((body.match(/\.click\(\)/g) ?? []).length, 1, "a single submit per attempt (sequential awaits, never concurrent)");
  assert.match(body, /for \(let i = 0; i < 5; i\+\+\)/, "bounded attempts");
  assert.match(body, /loginFailures\.push\(\{ label, stage/);
  assert.doesNotMatch(body.slice(body.indexOf("loginFailures.push")), /a\.email|a\.password/, "no credential in the failure record");
});

test("preview-infrastructure exclusion is exact; every other host/path and the dangerous error names stay recorded and counted", () => {
  assert.match(UAT, /u\.hostname === "vercel\.live" && u\.pathname === "\/_next-live\/feedback\/feedback\.js"/);
  assert.equal((UAT.match(/preview-infrastructure/g) ?? []).length >= 3, true);
  // the exclusion may not be broadened to a wildcard, a suffix or all third parties
  assert.doesNotMatch(UAT, /hostname\.(endsWith|includes|startsWith)\("vercel\.live"\)|\/vercel\\.live\/\.test\(u\.hostname\)/);
  // benign aborts are separate and ONLY ERR_ABORTED; the three connectivity failures are never in that bucket
  assert.match(UAT, /if \(\/ERR_ABORTED\/\.test\(failure\)\)/);
  assert.doesNotMatch(UAT, /ERR_(NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|CONNECTION_CLOSED)[^\n]*benign/);
  assert.match(UAT, /no unrecovered network failure/);
  assert.match(UAT, /req\.method\(\) !== "GET" && req\.method\(\) !== "HEAD"/);
});

test("station section: every login in the station loop names the loop variable (regression: undefined `label`)", () => {
  const body = UAT.slice(UAT.indexOf("async function sectionStations"), UAT.indexOf("async function sectionResponsive"));
  assert.match(body, /await login\(s\.page, a, x\.label\)/);
  assert.doesNotMatch(body, /login\(s\.page, a, label\)/);
});

test("mobile notification check targets the control the mobile layout actually shows (Alerts), not the desktop-rail bell hidden at that width", () => {
  const idx = UAT.indexOf('check("notifications", "aso-kul (mobile)');
  assert.ok(idx > 0, "the mobile notifications check exists");
  const block = UAT.slice(Math.max(0, idx - 700), idx);
  assert.match(block, /name: \/\^Alerts\//, "the mobile bell is the bottom-bar Alerts control");
  assert.doesNotMatch(block, /name: \/\^Notifications\//, "the desktop-only Notifications control is not clicked at 390px");
});

test("CaterLink preview test expects the canonical landing page for every VECTA representative (role dashboards land on /avsec/my-dashboard)", async () => {
  const src = read("scripts/staging/preview-caterlink-test.mjs");
  const { landsOnRoleDashboard } = await import("../lib/auth/role-capabilities.ts");
  for (const role of ["operation_manager", "main_enforcement", "sso", "aso"]) {
    const at = src.indexOf(`["${role}`);
    assert.ok(at >= 0, `${role} is a representative`);
    const expected = src.slice(at, src.indexOf("]", at)).split(",")[1].trim().replace(/"/g, "");
    assert.equal(expected, landsOnRoleDashboard([role]) ? "/avsec/my-dashboard" : "/", `${role} landing expectation`);
  }
});

test("portal verifier baseline: 8 buckets (completed-forms added by the reviewed migration) and the form-assignment refusal counts as an authorization refusal", () => {
  const src = read("scripts/staging/verify-caterlink-portal-accounts.mjs");
  assert.match(src, /18 org_teams; 8 buckets/);
  assert.match(src, /storage\.buckets"\)\) === 8/);
  assert.match(src, /assignment does not include the/);
});

test("profile-status verifier lists the object's own parent folder (works for nested signature paths), not only the first path segment", () => {
  const src = read("scripts/staging/verify-profile-status-staging.mjs");
  assert.match(src, /lastIndexOf\("\/"\)/);
  assert.doesNotMatch(src, /list\(mv\.sig\.split\("\/"\)\[0\]/);
});

test("hosted verifiers encode the least-privilege movement rule: PEN receipt officer reads the PEN-destined movement, Staff Profiling at PEN does not", () => {
  const prof = read("scripts/staging/verify-profile-status-staging.mjs");
  assert.match(prof, /\["aso", true, true,/);
  assert.match(prof, /\["profiling_aso", false, false,/);
  const ext = read("scripts/staging/verify-external-workflows-staging.mjs");
  assert.match(ext, /profiling_aso: false/);
  const e2e = read("scripts/staging/e2e-external-workflows.mjs");
  assert.match(e2e, /"profiling_aso", "aso-no-caterlink"\]/);
});

test("the UAT run window is configurable (default 360 minutes) in both the harness and the preflight, so a shorter clean rerun can still be guarded against midnight", () => {
  const uat = read("scripts/staging/hosted-uat.mjs");
  const pre = read("scripts/staging/uat-preflight.mjs");
  assert.match(uat, /argVal\("max-run-minutes"\) \?\? "360"/);
  assert.match(uat, /--max-run-minutes=\$\{maxRunMinutes\}/);
  assert.doesNotMatch(uat, /"--max-run-minutes=360"/);
  assert.match(pre, /argVal\("max-run-minutes"\) \?\? "360"/);
  assert.match(pre, /\(maxRunMinutes \+ 45\) \* 60/);
});
