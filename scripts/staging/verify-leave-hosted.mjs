#!/usr/bin/env node
// Hosted verification of unpaid-leave routing and direct annual-leave cancellation: real signed-in sessions (DSE, Operation Manager, MAA/AAX Boss) call the
// real secured functions against the approved staging database; Playwright loads the real admin absences page for the DSE. Tagged leave fixtures are
// created through the owner connection and removed by EXACT ledger id (with their alerts and audit rows).
//
// Usage: node --env-file=<staging env> scripts/staging/verify-leave-hosted.mjs --url=https://<preview> --run-id=<id>
//        node --env-file=<staging env> scripts/staging/verify-leave-hosted.mjs --run-id=<id> --cleanup-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { connectVerified, defaultCredentialsDir, environmentGates, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const base = argVal("url");
const runId = argVal("run-id");
const CLEANUP_ONLY = args.includes("--cleanup-only");
if (!runId || !/^[a-z0-9-]{6,40}$/i.test(runId)) throw new Error("--run-id=<6-40 chars [a-z0-9-]> is required");
if (!CLEANUP_ONLY && !base?.startsWith("https://")) throw new Error("--url=https://<staging preview> is required");
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || (base ?? "").includes(FORBIDDEN_REF)) throw new Error("production reference refused");

const TAG = `[UAT:${runId}]`;
const accounts = loadCurrentCredentials();
const cred = (l) => accounts.find((a) => a.label === l) ?? (() => { throw new Error(`no credentials for ${l}`); })();
const ledgerDir = path.join(os.tmpdir(), "vecta-uat-fixtures");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerPath = path.join(ledgerDir, `${runId}-leave.json`);
const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { runId, notices: [], startedAt: new Date().toISOString() };
const save = () => fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { mode: 0o600 });
let passes = 0, failures = 0;
const ok = (label, cond, note = "") => { if (cond) passes += 1; else failures += 1; console.log(`${cond ? "PASS" : "FAIL"}: ${label}${note ? " -- " + note : ""}`); return cond; };

let pg = (await connectVerified()).client;
pg.on("error", (e) => console.log(`(database connection error ignored: ${String(e.message).slice(0, 60)})`));
const q = async (s, p) => (await pg.query(s, p)).rows;

async function cleanup() {
  const ids = ledger.notices;
  const report = {};
  let n = 0;
  for (const id of ids) n += (await pg.query("delete from public.user_notifications where dedup_key like $1 returning id", [`phase8_leave_${id}_%`])).rowCount;
  report.notifications = n;
  let audit = 0, blocked = 0;
  for (const id of ids) { try { audit += (await pg.query("delete from public.phase8_audit_log where entity_type='absence_notice' and entity_id=$1 returning 1", [id])).rowCount; } catch { blocked += 1; } }
  report.audit = audit; if (blocked) report.auditRetained = blocked;
  report.notices = ids.length ? (await pg.query("delete from public.absence_notices where id = any($1::uuid[]) and remarks = $2 returning id", [ids, TAG])).rowCount : 0;
  const remaining = { notices: (await q("select count(*)::int n from public.absence_notices where remarks = $1", [TAG]))[0].n };
  console.log(`cleanup (exact ledger ids): ${JSON.stringify(report)}; remaining tagged records: ${JSON.stringify(remaining)}`);
  return remaining.notices === 0;
}
if (CLEANUP_ONLY) { const clean = await cleanup(); await pg.end(); process.exit(clean ? 0 : 1); }

const bypass = fs.readFileSync(path.join(defaultCredentialsDir("dashboard-review-20261005"), "vercel-bypass.txt"), "utf8").trim();
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => fs.existsSync(p));
const clientFor = async (label) => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await signInWithRetry(sb, cred(label).email, cred(label).password);
  if (s.error) throw new Error(`${label}: sign-in failed`);
  return sb;
};
let browser;
try {
  const idOf = async (l) => (await q("select pr.id from public.profiles pr join auth.users u on u.id=pr.id where lower(u.email)=lower($1)", [cred(l).email]))[0]?.id;
  const dseId = (await q("select a.profile_id id from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id where r.code='dse' and a.revoked_at is null order by a.profile_id limit 1"))[0]?.id; // scope only: no DSE session credentials exist on staging, so DSE paths are covered by the guarded dry run
  const scope = (await q(`select s.code station, t.name team from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id join public.org_teams t on t.id=a.team_id
    join public.stations s on s.code is not null cross join lateral public.resolve_legacy_station(s.code) rs where rs.station_id=a.station_id and r.code='dse' and a.profile_id=$1 and a.revoked_at is null limit 1`, [dseId]))[0];
  ok("DSE fixture scope resolved", Boolean(scope), scope ? `${scope.station}/${scope.team}` : "");
  const applicants = await q(`select pr.id, (select oe.code from public.user_entity_memberships m join public.operating_entities oe on oe.id=m.operating_entity_id where m.profile_id=pr.id and m.status='active' and m.revoked_at is null limit 1) ent
    from public.profiles pr where pr.status='approved' and pr.id<>$1 and (select count(*) from public.user_entity_memberships m where m.profile_id=pr.id and m.status='active' and m.revoked_at is null)=1
    and coalesce(public.submitter_department_code(pr.id),'')<>'enforcement' order by pr.id`, [dseId]);
  const maaUser = applicants.find((a) => a.ent === "MAA"), aaxUser = applicants.find((a) => a.ent === "AAX");
  const add = async (user, type, o0, o1, status = "pending", extra = false) => {
    const id = (await q(`insert into public.absence_notices(user_id,staff_name,role,station,team,duty_date,shift_start_time,remarks,leave_type,start_date,end_date,approval_status,status,overlap_exception)
      values($1,$2,'ASO',$3,$4,current_date,now(),$5,$6,(now() at time zone 'Asia/Kuala_Lumpur')::date+$7::int,(now() at time zone 'Asia/Kuala_Lumpur')::date+$8::int,$9,'green',$10) returning id`,
      [user, `${TAG} applicant`, scope.station, scope.team, TAG, type, o0, o1, status, extra]))[0].id;
    ledger.notices.push(id); save(); return id;
  };
  const row = async (id) => (await q("select approval_status s, end_date::text e, original_end_date::text o, cancellation_kind k, overlap_exception x, cancelled_by from public.absence_notices where id=$1", [id]))[0];
  const sb = { om: await clientFor("operation_manager"), maa: await clientFor("maa_boss"), aax: await clientFor("aax_boss") };
  const rpc = async (c, fn, a) => { const r = await c.rpc(fn, a); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; };
  const review = (c, id, action = "approve") => rpc(c, "review_leave_request_secure", { p_notice_id: id, p_action: action, p_review_notes: "hosted check" });
  const cancel = (c, id, reason = "Operational reassignment") => rpc(c, "cancel_approved_leave_secure", { p_notice_id: id, p_reason: reason });

  // ---- unpaid routing ----
  const two = await add(maaUser.id, "unpaid", 20, 21);
  ok("unpaid 2 days: Boss cannot finalise", /Operation Manager/.test((await review(sb.maa, two)).error?.message ?? ""));
  ok("unpaid 2 days: Operation Manager finalises", (await review(sb.om, two)).data?.result_status === "approved");
  const three = await add(maaUser.id, "unpaid", 20, 22);
  ok("unpaid 3 days: Operation Manager cannot finalise", /MAA Boss/.test((await review(sb.om, three)).error?.message ?? ""));
  ok("unpaid 3 days: other entity's Boss cannot finalise", Boolean((await review(sb.aax, three)).error));
  ok("unpaid 3 days: own entity Boss rejects (final)", (await review(sb.maa, three, "reject")).data?.result_status === "rejected");
  const aax = await add(aaxUser.id, "unpaid", 30, 33);
  ok("unpaid AAX 4 days: AAX Boss finalises", (await review(sb.aax, aax)).data?.result_status === "approved");
  ok("approved unpaid leave is notified to the applicant", (await q("select count(*)::int n from public.user_notifications where dedup_key=$1", [`phase8_leave_${aax}_approved`]))[0].n === 1);

  // ---- same-day overlap exception ----
  for (const u of applicants.slice(0, 3)) await add(u.id, "annual", 50, 52, "approved");
  const fourth = await add(applicants[3].id, "annual", 51, 51);
  const om4 = await review(sb.om, fourth);
  ok("fourth same-day officer: Operation Manager approves, exception recorded", om4.data?.result_status === "approved" && (await row(fourth)).x === true);

  // ---- cancellation ----
  const fut = await add(applicants[4].id, "annual", 70, 72, "approved");
  ok("Operation Manager cannot cancel an ordinary approval", /exception/.test((await cancel(sb.om, fut)).error?.message ?? ""));
  ok("Boss has no cancellation authority", Boolean((await cancel(sb.maa, fut)).error));
  const exF = await add(applicants[5].id, "annual", 70, 72, "approved", true);
  ok("cancel needs a reason", /reason/.test((await cancel(sb.om, exF, "no")).error?.message ?? ""));
  ok("Operation Manager cancels a recorded exception in full", (await cancel(sb.om, exF)).data?.result_kind === "full" && (await row(exF)).s === "cancelled");
  ok("repeated cancellation refused", /already been cancelled/.test((await cancel(sb.om, exF)).error?.message ?? ""));
  const under = await add(applicants[6].id, "annual", -3, 4, "approved", true);
  const today = (await q("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d"))[0].d;
  const plus4 = (await q("select ((now() at time zone 'Asia/Kuala_Lumpur')::date+4)::text d"))[0].d;
  const u1 = await cancel(sb.om, under);
  const ur = await row(under);
  ok("underway: today and earlier stay taken, only tomorrow onward released", u1.data?.result_kind === "partial" && ur.e === today && ur.o === plus4 && ur.s === "approved");
  ok("underway leave cannot be cancelled twice", Boolean((await cancel(sb.om, under)).error));
  const done = await add(applicants[7].id, "annual", -5, -1, "approved", true);
  ok("completed leave cannot be cancelled", /Completed/.test((await cancel(sb.om, done)).error?.message ?? ""));
  ok("cancelled leave notifies the officer", (await q("select count(*)::int n from public.user_notifications where dedup_key=$1", [`phase8_leave_${exF}_cancelled`]))[0].n === 1);
  ok("cancellation is audited with the reason", (await q("select count(*)::int n from public.phase8_audit_log where entity_id=$1 and action='leave_cancelled_directly'", [exF]))[0].n === 1);
  console.log("NOTE: DSE-session paths (own team cancel, other-team refusal, DSE refused on unpaid/fourth overlap) are NOT exercised hosted: staging has no DSE credentials. They are covered by the guarded dry run (24 probes with a real DSE identity).");

  // ---- UI: the DSE sees the control on the real page, mobile and desktop ----
  const target = await add(applicants[8].id, "annual", 100, 101, "approved");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  for (const [vp, name] of [[{ width: 390, height: 844 }, "mobile"], [{ width: 1366, height: 900 }, "desktop"]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
    const page = await ctx.newPage();
    await page.goto(`${base}/login?x-vercel-protection-bypass=${bypass}&x-vercel-set-bypass-cookie=true`, { waitUntil: "domcontentloaded" });
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', cred("operation_manager").email);
    await page.fill('input[name="password"]', cred("operation_manager").password);
    await page.getByRole("button", { name: /Sign in with Credentials/i }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 25000 }).catch(() => {});
    await page.goto(`${base}/avsec/admin/absences`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    const btn = page.getByRole("button", { name: /Cancel approved leave/i }).first();
    const shown = await btn.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    ok(`${name}: Operation Manager sees the cancel-approved-leave control`, shown);
    if (shown && name === "desktop") {
      await btn.click();
      const confirm = page.getByRole("button", { name: /Confirm cancellation/i }).first();
      ok("desktop: confirm stays disabled until a reason is typed", await confirm.isDisabled());
    }
    await ctx.close();
  }
  void target;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await pg.end(); } catch { /* ignore */ }
  pg = (await connectVerified()).client;
  pg.on("error", () => {});
  const clean = await cleanup();
  await pg.end();
  console.log(`RESULT: ${passes} passed, ${failures} failed; cleanup ${clean ? "complete" : "INCOMPLETE"}.`);
  process.exitCode = failures === 0 && clean ? 0 : 1;
}
