import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p: string) => fs.readFileSync(p, "utf8");
const ACTION = read("lib/icms/actions/transactions.ts");
const PART_B = ACTION.slice(ACTION.indexOf("export async function completePartB("), ACTION.indexOf("export async function completePartC("));
const HOLD = fs.readFileSync("lib/icms/checkpoint-hold-messages.ts", "utf8");
const DETAIL = fs.readFileSync("app/(icms)/icms/transactions/[id]/page.tsx", "utf8");
const PAGE = read("app/(icms)/icms/transactions/[id]/part-b/page.tsx");
const FORM = read("components/icms/checkpoint-form.tsx");
const MIG = read("supabase/migrations/20261107000001_caterlink_part_b_checkpoint.sql");
const CODE = MIG.replace(/--.*$/gm, "");

test("Part B is an activated workflow: the page renders the form, not the placeholder", () => {
  assert.doesNotMatch(PAGE, /ModuleNotActivated|not activated|BLOCKED/i);
  assert.match(PAGE, /requireCheckpointRole\("post2_avsec"\)/);
  assert.match(PAGE, /<CheckpointForm part="part_b"/);
  assert.match(PAGE, /checkpointOrderError\(/, "a movement that is not waiting for Part B shows the order message instead of the form");
  assert.match(PAGE, /notFound\(\)/, "an invisible (RLS) movement is a 404, not a leak");
  assert.match(PAGE, /<h1 /);
});

test("the server action writes ONLY through the secured RPC and takes no identity, date or authorization from the client", () => {
  assert.match(PART_B, /rpc\("record_caterlink_part_b_secure"/);
  assert.match(PART_B, /requireCheckpointRole\("post2_avsec"\)/);
  assert.doesNotMatch(PART_B, /\.from\("(part_b|part_b_c|transactions|seals|seal_verifications|incidents|caterlink_incidents)"\)/, "no direct table write");
  assert.doesNotMatch(PART_B, /officer_name|officer_staff_id|checkpoint_date|checkpoint_time|completed_by|profile\.id/, "no client-supplied officer or time; no actor id sent");
  assert.doesNotMatch(PART_B, /as unknown as/, "typed RPC call");
  assert.match(PART_B, /uploadDataUrl\("signatures", signature, "part-b"\)/, "the signature goes to the prefix the database requires");
  assert.match(PART_B, /violates\|constraint\|relation/, "database internals are never shown to the officer");
});

test("outcomes: every escalation outcome shows the safe bilingual instruction; approval redirects with approved/completed", () => {
  for (const k of ["SEAL_MISMATCH", "WRONG_SEAL_COLOR", "WHITELIST_VIOLATION"]) assert.match(HOLD, new RegExp(k));
  assert.match(HOLD, /Do not release the vehicle/);
  assert.match(PART_B, /partBHoldMessage\(row\.outcome\)\) redirect\(`\/icms\/transactions\/\$\{transactionId\}\?escalated=1&hold=\$\{row\.outcome\}`\)/);
  assert.match(PART_B, /redirect\(`\/icms\/transactions\/\$\{transactionId\}\?escalated=1`\)/);
  // the page shows the instruction from the whitelisted table only; it never echoes the query string
  assert.match(DETAIL, /partBHoldMessage\(flags\.hold\)/);
  assert.match(DETAIL, /role="alert"[\s\S]{0,200}\{holdMessage\}/);
  assert.match(HOLD, /hasOwnProperty\.call\(PART_B_HOLD_MESSAGES, code\)/);
  assert.match(PART_B, /"completed" : "approved"/);
});

test("the form: server-side date/time, server decides the whitelist, no dead-end incident link, accessible fields", () => {
  assert.doesNotMatch(FORM, /name="checkpoint_date"|name="checkpoint_time"/);
  assert.match(FORM, /vehicles\?: /);
  assert.match(FORM, /if \(!vehicles \|\| !drivers\) return true/);
  assert.doesNotMatch(FORM, /\/incident`/);
  assert.match(FORM, /role="alert"/);
  assert.match(FORM, /htmlFor="observed_vehicle_number"/);
});

test("migration: server-derived actor, uniform refusal, state machine, idempotency, immutability, audit, notification, grants", () => {
  assert.match(CODE, /v_uid uuid := auth\.uid\(\)/);
  assert.match(CODE, /security definer\s+set search_path to 'public'/);
  assert.match(CODE, /check_station_caterlink_capability\(v_tx\.aoc_id, v_station_code, 'scan'\)/);
  assert.doesNotMatch(CODE, /can_user_scan_caterlink/, "the scan-decision invariant: no database function builds on can_user_scan_caterlink");
  assert.match(CODE, /duty_records r where r\.profile_id = v_uid/);
  assert.match(CODE, /profiling_so', 'profiling_aso'/);
  assert.match(CODE, /for update;/, "the transaction row is locked");
  assert.match(CODE, /create unique index if not exists part_b_c_one_per_stage on public\.part_b_c \(transaction_id, checkpoint_stage\)/);
  assert.match(CODE, /before update on public\.part_b_c for each row execute function public\.part_b_c_immutable/);
  assert.match(CODE, /phase8_write_audit\('caterlink_part_b_record'/);
  assert.match(CODE, /'caterlink_checkpoint_escalated'/);
  assert.match(CODE, /rd\.code in \('caterlink_management', 'operation_manager'\)/, "notifications go only to management recipients in the transaction's AOC");
  assert.match(CODE, /revoke execute on function public\.record_caterlink_part_b_secure\([^)]*\) from public, anon;/);
  assert.match(CODE, /grant execute on function public\.record_caterlink_part_b_secure\([^)]*\) to authenticated, service_role;/);
  assert.match(CODE, /revoke execute on function public\.caterlink_checkpoint_escalate_internal\([^)]*\) from public, anon, authenticated;/);
  assert.match(CODE, /p_signature_url !~ '\^part-b\//);
});

test("workflow mirror: outbound CREATED -> INFLIGHT_POST_APPROVED; inbound AIRPORT_POST_APPROVED -> COMPLETED (same as lib/icms/workflow.ts)", () => {
  const wf = read("lib/icms/workflow.ts");
  assert.match(wf, /requiredStatus: "CREATED",\s+nextStatus: "INFLIGHT_POST_APPROVED"/);
  assert.match(wf, /requiredStatus: "AIRPORT_POST_APPROVED",\s+nextStatus: "COMPLETED",\s+finalizes: true/);
  assert.match(CODE, /v_required := 'AIRPORT_POST_APPROVED'; v_next := 'COMPLETED'/);
  assert.match(CODE, /v_required := 'CREATED'; v_next := 'INFLIGHT_POST_APPROVED'/);
});

test("Parts C, D, Hub and REDQ remain BLOCKED stubs (this change activates Part B only)", () => {
  for (const f of ["part-c", "part-d", "part-hub", "part-redq"]) assert.match(read(`app/(icms)/icms/transactions/[id]/${f}/page.tsx`), /ModuleNotActivated/, f);
});
