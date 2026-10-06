#!/usr/bin/env node
// Real staging sessions (publishable key; each identity's own JWT) for the profile-status correction. Run with --phase=before
// (documents the flaw: pending/rejected/deactivated read the movement) and --phase=after (they must be denied). Everything else must be
// identical in both phases. Reads only: REST tables, signed URL / download / list through the Storage API, and RPCs. Prints labels and
// booleans only.
//   node --env-file=.env.local scripts/staging/verify-profile-status-staging.mjs --phase=before|after
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const phase = (process.argv.find((a) => a.startsWith("--phase=")) ?? "").split("=")[1];
if (!["before", "after"].includes(phase)) throw new Error("--phase=before|after is required");
environmentGates();
const creds = loadCurrentCredentials();
const probeFx = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-storage-probe-fixtures.json"), "utf8"));
const { client: pg } = await connectVerified();
await pg.query("BEGIN READ ONLY");
const mv = (await pg.query("select transaction_id id, signature_url sig from public.caterlink_checkpoint_part_a where signature_url = any($1) order by completed_at limit 1", [probeFx.referenced])).rows[0];
const dv = (await pg.query("select delivery_id id, signature_url sig from public.caterlink_vendor_checkpoints where signature_url = any($1) and stage = 'A' limit 1", [probeFx.referenced])).rows[0];
await pg.query("ROLLBACK"); await pg.end();
if (!mv || !dv) throw new Error("fixtures not found");

let failures = 0, flawRows = 0;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const sessions = new Map();
async function client(label) {
  if (label === "anon") return createClient(url, anonKey, { auth: { persistSession: false } });
  if (sessions.has(label)) return sessions.get(label);
  const c = creds.find((a) => a.label === label);
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error } = await signInWithRetry(sb, c.email, c.password);
  if (error) throw new Error(`sign-in failed for ${label}`);
  sessions.set(label, sb);
  return sb;
}
const rows = async (sb, table, col, val) => ((await sb.from(table).select("*").eq(col, val)).data ?? []).length;
async function movement(label) {
  const sb = await client(label);
  return {
    tx: (await rows(sb, "transactions", "id", mv.id)) === 1,
    seals: (await rows(sb, "seals", "transaction_id", mv.id)) >= 1,
    partA: (await rows(sb, "caterlink_checkpoint_part_a", "transaction_id", mv.id)) === 1,
    signed: !(await sb.storage.from("signatures").createSignedUrl(mv.sig, 60)).error,
    download: !(await sb.storage.from("signatures").download(mv.sig)).error,
    listed: ((await sb.storage.from("signatures").list(mv.sig.split("/")[0], { limit: 200 })).data ?? []).some((o) => `${mv.sig.split("/")[0]}/${o.name}` === mv.sig),
  };
}
async function vendor(label) {
  const sb = await client(label);
  return {
    delivery: (await rows(sb, "caterlink_vendor_deliveries", "id", dv.id)) === 1,
    checkpoints: (await rows(sb, "caterlink_vendor_checkpoints", "delivery_id", dv.id)) >= 1,
    signed: !(await sb.storage.from("signatures").createSignedUrl(dv.sig, 60)).error,
  };
}
const allTrue = (o) => Object.values(o).every(Boolean);
const noneTrue = (o) => Object.values(o).every((v) => !v);
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v ? "Y" : "n"}`).join(" ");

// label, movement expectation, vendor-delivery expectation
const matrix = [
  ["aso-kul", true, false, "approved KUL - MAA officer (origin station)"],
  ["aso", false, true, "approved PEN officer (PEN vendor deliveries only)"],
  ["aso-jhb", false, false, "approved JHB officer"],
  ["caterlink_management", true, true, "CaterLink Management"],
  ["operation_manager", true, false, "Operation Manager"],
  ["caterlink-driver", true, false, "creating Driver"],
  ["caterlink-vendor", false, true, "owning Vendor"],
  ["profiling_aso", false, false, "Staff Profiling (PEN)"],
  ["neg-pending-profile", "FLAW", false, "PENDING profile, active assignment"],
  ["neg-rejected-profile", "FLAW", false, "REJECTED profile, active assignment"],
  ["neg-deactivated-profile", "FLAW", false, "DEACTIVATED profile, active assignment"],
  ["neg-revoked-assignment", false, false, "approved, REVOKED assignment"],
  ["neg-expired-assignment", false, false, "approved, EXPIRED assignment"],
  ["neg-future-assignment", false, false, "approved, FUTURE-dated assignment"],
  ["anon", false, false, "anonymous"],
];
console.log(`=== PROFILE-STATUS HOSTED MATRIX (${phase.toUpperCase()}): movement = transaction + seals + Part A + signed URL + download + list; vendor = delivery + checkpoints + signed URL ===`);
for (const [label, wantM, wantV, desc] of matrix) {
  const m = await movement(label), v = await vendor(label);
  let mOk;
  let mNote = "";
  if (wantM === "FLAW") {
    if (phase === "before") { mOk = true; mNote = allTrue(m) ? " [FLAW PRESENT: readable]" : " [flaw not present]"; if (allTrue(m)) flawRows += 1; }
    else mOk = noneTrue(m);
    if (phase === "after" && !mOk) mNote = " [STILL READABLE]";
  } else mOk = wantM ? allTrue(m) : noneTrue(m);
  const vOk = wantV ? allTrue(v) : noneTrue(v);
  if (!mOk || !vOk) failures += 1;
  console.log(`${mOk && vOk ? "PASS" : "FAIL"}: ${label.padEnd(24)} ${desc.padEnd(46)} movement[${fmt(m)}]${mNote}  vendor[${fmt(v)}]`);
}

// scan / receipt unchanged, and Driver/Vendor CaterLink-only isolation
const rpcBool = async (label, fn, args) => (await (await client(label)).rpc(fn, args)).data === true;
const checks = [
  ["scan: PEN officer true at PEN", await rpcBool("aso", "can_user_scan_caterlink", { p_station_code: "PEN" }), true],
  ["scan: JHB officer true at JHB", await rpcBool("aso-jhb", "can_user_scan_caterlink", { p_station_code: "JHB" }), true],
  ["scan: KUL officer false at KUL", await rpcBool("aso-kul", "can_user_scan_caterlink", { p_station_code: "KUL - MAA" }), false],
  ["scan: Staff Profiling false at PEN", await rpcBool("profiling_aso", "can_user_scan_caterlink", { p_station_code: "PEN" }), false],
  ["scan: Management false at PEN", await rpcBool("caterlink_management", "can_user_scan_caterlink", { p_station_code: "PEN" }), false],
  ["scan: Driver false at PEN", await rpcBool("caterlink-driver", "can_user_scan_caterlink", { p_station_code: "PEN" }), false],
  ["scan: Vendor false at JHB", await rpcBool("caterlink-vendor", "can_user_scan_caterlink", { p_station_code: "JHB" }), false],
  ["receipt: KCH officer true at KCH", await rpcBool("aso-kch-receipt", "can_user_confirm_caterlink_receipt", { p_station_code: "KCH" }), true],
  ["receipt: BKI officer true at BKI", await rpcBool("aso-bki-receipt", "can_user_confirm_caterlink_receipt", { p_station_code: "BKI" }), true],
  ["receipt: Management false", await rpcBool("caterlink_management", "can_user_confirm_caterlink_receipt", { p_station_code: "KCH" }), false],
  ["receipt: Driver false", await rpcBool("caterlink-driver", "can_user_confirm_caterlink_receipt", { p_station_code: "KCH" }), false],
  ["receipt: Vendor false", await rpcBool("caterlink-vendor", "can_user_confirm_caterlink_receipt", { p_station_code: "BKI" }), false],
];
const VECTA = ["report_sec014", "team_rosters", "duty_records", "overtime_requests", "absence_notices", "bay_board", "stations", "shifts", "user_role_assignments", "investigation_cases", "announcements"];
for (const label of ["caterlink-driver", "caterlink-vendor"]) {
  const sb = await client(label);
  let leak = 0;
  for (const t of VECTA) { const r = await sb.from(t).select("*", { count: "exact", head: true }); leak += r.error ? 0 : (r.count ?? 0); }
  checks.push([`isolation: ${label} reads no VECTA table row`, leak === 0, true]);
}
const dsb = await client("caterlink-driver"), vsb = await client("caterlink-vendor");
checks.push(["isolation: Driver reads no vendor workflow data; Vendor reads no catering movement data", (await rows(dsb, "caterlink_vendor_deliveries", "id", dv.id)) === 0 && (await rows(vsb, "transactions", "id", mv.id)) === 0, true]);
for (const [l, got, want] of checks) { if (got !== want) failures += 1; console.log(`${got === want ? "PASS" : "FAIL"}: ${l}`); }
console.log(phase === "before" ? `\nBEFORE: ${flawRows} of 3 non-approved profiles read the movement bundle (the flaw), everything else as intended. Total failures: ${failures}` : `\nAFTER: Total failures: ${failures}`);
process.exit(failures ? 1 : 0);
