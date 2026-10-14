#!/usr/bin/env node
// Read-only (every probe runs inside a ROLLED-BACK transaction) authorization probe of the CaterLink workflow functions that have no
// working caller in the application. Staging only. Uses the tagged create-tx fixture of --run-id. Prints names and outcomes only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { environmentGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";
const runId = process.argv.find((a) => a.startsWith("--run-id="))?.split("=")[1];
environmentGates();
if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) throw new Error("production reference present");
const ledger = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-uat-fixtures", `${runId}.json`), "utf8"));
const tx = ledger.tx[0];
const manifest = loadCurrentManifest();
const { client } = await connectVerified();
const q = async (s, p) => (await client.query(s, p)).rows;
async function asUser(label, fn) {
  const uid = manifest.find((a) => a.label === label)?.authUserId;
  await client.query("BEGIN");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    return await fn();
  } catch (e) { return `ERROR: ${String(e.message).slice(0, 90)}`; } finally { await client.query("ROLLBACK"); }
}
console.log("== current_user_role() per account (the legacy gate used by skip_part_d)");
for (const l of ["aso", "aso-kul", "caterlink_management", "operation_manager", "main_enforcement", "super_admin", "hub_se", "caterlink-driver", "caterlink-vendor"]) {
  console.log(l.padEnd(22), await asUser(l, async () => (await q("select public.current_user_role() r"))[0].r));
}
console.log("== raise_caterlink_incident_secure on a movement the caller has no business with (rolled back)");
for (const l of ["aso", "aso-kul", "aso-jhb", "caterlink_management", "caterlink-driver", "caterlink-vendor", "aso-no-caterlink", "neg-pending-profile"]) {
  const r = await asUser(l, async () => {
    const out = await q("select * from public.raise_caterlink_incident_secure($1, 'OTHER', 'probe', 'low', null)", [tx.id]);
    return `ACCEPTED -> ${out[0]?.transaction_status}`;
  });
  console.log(l.padEnd(22), r);
}
console.log("== skip_part_d role gate (status is CREATED, so an authorised caller is stopped by the ORDER check, an unauthorised one by the ROLE check)");
for (const l of ["aso", "caterlink_management", "operation_manager", "super_admin", "main_enforcement"]) {
  console.log(l.padEnd(22), await asUser(l, async () => { await q("select public.skip_part_d($1, 'probe')", [tx.id]); return "ACCEPTED"; }));
}
console.log("== destination receipt on a movement still CREATED (no Part B/C/D) (rolled back)");
await client.query("BEGIN");
try {
  const kul = (await q("select id from public.org_stations where code = 'KUL - MAA'"))[0].id;
  await client.query("update public.transactions set destination_station_id = $1 where id = $2", [kul, tx.id]);
  const uid = manifest.find((a) => a.label === "aso-kul").authUserId;
  await client.query("select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  const out = await q("select * from public.confirm_caterlink_destination_receipt_secure($1, 'KUL - MAA', 'receipt/probe.png', 'probe')", [tx.id]).catch((e) => `ERROR: ${e.message.slice(0, 100)}`);
  console.log("aso-kul", typeof out === "string" ? out : `ACCEPTED -> ${out[0]?.status}`);
} finally { await client.query("ROLLBACK"); }
console.log("after: status still", (await q("select status from public.transactions where id = $1", [tx.id]))[0].status);
await client.end();
