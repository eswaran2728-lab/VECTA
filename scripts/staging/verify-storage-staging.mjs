#!/usr/bin/env node
// Real-account storage-security probes on ACTUAL staging after the storage repairs (publishable key; each identity's own
// session; the Storage API itself: upload, list, download, signed URL, overwrite, delete). Writes clearly marked probe objects,
// one fixture movement and one fixture vendor delivery, and ALWAYS removes the unreferenced probe objects. Prints counts/labels only.
//   node --env-file=.env.local scripts/staging/verify-storage-staging.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
import { environmentGates, connectVerified } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

environmentGates();
const admin = resolveStagingAdminContext().client;
const creds = loadCurrentCredentials();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const tag = Date.now().toString().slice(-7);
let failures = 0;
const check = (l, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${l}${note ? " -- " + note : ""}`); return ok; };
const sessions = new Map();
async function S(label) {
  if (sessions.has(label)) return sessions.get(label);
  const c = creds.find((a) => a.label === label);
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await signInWithRetry(sb, c.email, c.password);
  if (error) throw new Error(`sign-in failed for ${label}`);
  const s = { sb, uid: data.user.id };
  sessions.set(label, s);
  return s;
}
const B = "signatures";
const paths = { driver: `e2e-probe/driver-${tag}.png`, vendor: `e2e-probe/vendor-${tag}.png`, aso: `e2e-probe/aso-${tag}.png`, mgmt: `e2e-probe/mgmt-${tag}.png`, orphan: `e2e-probe/orphan-${tag}.png` };
const referenced = new Set();
const txArgs = (seal, sig) => ({ p_origin_station: "KUL - MAA", p_direction: "OUTBOUND", p_route: "AIRCRAFT", p_vehicle_number: "E2E1234A", p_driver_name: "E2E Test Driver", p_driver_id: "E2ED001", p_seal_number: seal, p_signature_url: sig });
const delArgs = (seal, sig) => ({ p_station_code: "PEN", p_driver_name: "E2E Vendor Driver", p_driver_nric: "E2E-NRIC-001", p_vehicle_registration_no: `E2EV${tag}`, p_seal_number: seal, p_signature_url: sig });
try {
  // ---------- uploads ----------
  const uploaders = { driver: "caterlink-driver", vendor: "caterlink-vendor", aso: "aso", mgmt: "caterlink_management" };
  for (const [k, label] of Object.entries(uploaders)) {
    const up = await (await S(label)).sb.storage.from(B).upload(paths[k], png, { contentType: "image/png" });
    check(`${label}: authorised signature UPLOAD succeeds`, !up.error, up.error?.message);
  }
  const orphanUp = await admin.storage.from(B).upload(paths.orphan, png, { contentType: "image/png" });
  check("(setup) an unreferenced object owned by nobody exists", !orphanUp.error);
  const { client: pg } = await connectVerified();
  try {
    const rows = (await pg.query("select name, owner from storage.objects where bucket_id = 'signatures' and name like $1", [`e2e-probe/%-${tag}.png`])).rows;
    check("the Storage API records the uploader as owner (the write-side guard depends on it)", rows.find((r) => r.name === paths.driver)?.owner === (await S("caterlink-driver")).uid && rows.find((r) => r.name === paths.vendor)?.owner === (await S("caterlink-vendor")).uid);
  } finally { await pg.end(); }

  // ---------- list / download / signed URL / overwrite / delete across parties ----------
  const matrix = [["caterlink-driver", "driver"], ["caterlink-vendor", "vendor"], ["aso", "aso"], ["caterlink_management", "mgmt"], ["operation_manager", null], ["profiling_aso", null], ["aso-jhb", null]];
  for (const [label, own] of matrix) {
    const sb = (await S(label)).sb;
    const list = await sb.storage.from(B).list("e2e-probe", { limit: 200 });
    const names = (list.data ?? []).map((o) => `e2e-probe/${o.name}`).filter((n) => n.endsWith(`-${tag}.png`));
    check(`${label}: LIST shows ${own ? "only its own probe object" : "no probe object"}`, JSON.stringify(names.sort()) === JSON.stringify(own ? [paths[own]] : []), `${names.length} visible`);
    const others = Object.values(paths).filter((p) => p !== (own ? paths[own] : null));
    let dl = 0, signed = 0, over = 0, del = 0;
    for (const p of others) {
      if (!(await sb.storage.from(B).download(p)).error) dl += 1;
      if (!(await sb.storage.from(B).createSignedUrl(p, 60)).error) signed += 1;
      if (!(await sb.storage.from(B).upload(p, png, { contentType: "image/png", upsert: true })).error) over += 1;
      const r = await sb.storage.from(B).remove([p]);
      if (!r.error && (r.data ?? []).length) del += 1;
    }
    check(`${label}: DOWNLOAD / SIGNED URL / OVERWRITE / DELETE of ${others.length} other objects all denied`, dl === 0 && signed === 0 && over === 0 && del === 0, `dl=${dl} signed=${signed} overwrite=${over} delete=${del}`);
    if (own) {
      const mineDl = await sb.storage.from(B).download(paths[own]);
      const mineSigned = await sb.storage.from(B).createSignedUrl(paths[own], 60);
      check(`${label}: its own object downloads and signs`, !mineDl.error && !mineSigned.error);
      const overwrite = await sb.storage.from(B).upload(paths[own], png, { contentType: "image/png", upsert: true });
      check(`${label}: overwriting its own object is refused (signatures are immutable)`, !!overwrite.error);
    }
  }
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const aList = await anon.storage.from(B).list("e2e-probe");
  check("anon: LIST shows nothing", (aList.data ?? []).length === 0);
  check("anon: DOWNLOAD, SIGNED URL and UPLOAD are denied", !!(await anon.storage.from(B).download(paths.driver)).error && !!(await anon.storage.from(B).createSignedUrl(paths.driver, 60)).error && !!(await anon.storage.from(B).upload(`e2e-probe/anon-${tag}.png`, png)).error);
  const stillThere = await admin.storage.from(B).list("e2e-probe", { limit: 200 });
  check("no object was removed or replaced by the denied attempts", Object.values(paths).every((p) => (stillThere.data ?? []).some((o) => `e2e-probe/${o.name}` === p)));

  // ---------- legitimate workflow: a referenced signature is reachable by exactly the authorised parties ----------
  const drv = (await S("caterlink-driver")).sb;
  const tx = await drv.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-ST-${tag}`, paths.driver));
  check("Driver created a movement referencing its own uploaded signature", !tx.error, tx.error?.message);
  referenced.add(paths.driver);
  const can = async (label, p) => !(await (await S(label)).sb.storage.from(B).createSignedUrl(p, 60)).error;
  check("authorised: Driver (creator), Management and Operation Manager can sign the movement signature", (await can("caterlink-driver", paths.driver)) && (await can("caterlink_management", paths.driver)) && (await can("operation_manager", paths.driver)));
  check("authorised: a KUL station officer (can see the movement) can sign it", await can("aso-kul", paths.driver));
  check("denied: Vendor, PEN officer, JHB officer and Staff Profiling cannot sign the movement signature", !(await can("caterlink-vendor", paths.driver)) && !(await can("aso", paths.driver)) && !(await can("aso-jhb", paths.driver)) && !(await can("profiling_aso", paths.driver)));
  const vnd = (await S("caterlink-vendor")).sb;
  const del = await vnd.rpc("create_caterlink_vendor_delivery_secure", delArgs(`E2E-VS-${tag}`, paths.vendor));
  check("Vendor created a delivery referencing its own uploaded signature", !del.error, del.error?.message);
  referenced.add(paths.vendor);
  check("authorised: Vendor (owner), Management and the PEN officer can sign the vendor signature", (await can("caterlink-vendor", paths.vendor)) && (await can("caterlink_management", paths.vendor)) && (await can("aso", paths.vendor)));
  check("denied: Driver, JHB officer, KUL officer and Staff Profiling cannot sign the vendor signature", !(await can("caterlink-driver", paths.vendor)) && !(await can("aso-jhb", paths.vendor)) && !(await can("aso-kul", paths.vendor)) && !(await can("profiling_aso", paths.vendor)));
  // write-side guard: a record cannot reference someone else's signature object
  const steal = await drv.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-STEAL-${tag}`, paths.aso));
  check("a Driver cannot create a record that references the officer's signature object", !!steal.error && /different account/.test(steal.error.message), steal.error?.message);
  const stealV = await vnd.rpc("create_caterlink_vendor_delivery_secure", delArgs(`E2E-STEAL-V-${tag}`, paths.driver));
  check("a Vendor cannot create a delivery that references the Driver's signature object", !!stealV.error && /different account/.test(stealV.error.message));
  check("and the stolen reference did not make either object readable", !(await can("caterlink-vendor", paths.driver)) && !(await can("caterlink-driver", paths.aso)));
} finally {
  const toRemove = Object.values(paths).filter((p) => !referenced.has(p));
  const rm = await admin.storage.from(B).remove(toRemove);
  const left = await admin.storage.from(B).list("e2e-probe", { limit: 200 });
  console.log(`probe cleanup: removed ${(rm.data ?? []).length} unreferenced probe objects; ${(left.data ?? []).length} object(s) remain (the two referenced by certification fixtures)`);
}
fs.writeFileSync(path.join(os.tmpdir(), "vecta-storage-probe-fixtures.json"), JSON.stringify({ tag, referenced: [...referenced] }), { mode: 0o600 });
console.log(`Total failures: ${failures}`);
process.exit(failures ? 1 : 0);
