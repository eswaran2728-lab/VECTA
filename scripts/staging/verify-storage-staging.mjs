#!/usr/bin/env node
// Real-account storage-security probes on ACTUAL staging, for the signature bucket AFTER migrations 20261113000001 and 20261115000001 are
// applied (publishable key; each identity's own session; the Storage API itself: upload, list, download, signed URL, overwrite, delete).
// Every signature goes to a documented, parent-bound path (scripts/staging/lib/signature-fixtures.mjs) through the ACTOR'S OWN session; the
// service role is used ONLY to remove the unreferenced objects this run itself created. A refusal is credited as an authorization result only
// when it is a genuine RLS/database refusal; a fixture or setup fault is reported as INCONCLUSIVE (exit code 2), never as a pass.
//   node --env-file=.env.local scripts/staging/verify-storage-staging.mjs
// Exit codes: 0 all verdicts passed, 1 a control failed, 2 inconclusive (setup/fixture fault).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
import { environmentGates } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";
import { bound, uploadBound, createRecorder, classifyError, cleanupOwnOrphans, PNG_BYTES, SetupError } from "./lib/signature-fixtures.mjs";

environmentGates();
const admin = resolveStagingAdminContext().client; // cleanup of this run's own unreferenced objects only
const creds = loadCurrentCredentials();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const rec = createRecorder();
const sessions = new Map();
async function S(label) {
  if (sessions.has(label)) return sessions.get(label);
  const c = creds.find((a) => a.label === label);
  if (!c) throw new SetupError(`no credentials for ${label}`);
  const sb = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await signInWithRetry(sb, c.email, c.password);
  if (error) throw new SetupError(`sign-in failed for ${label}`);
  const s = { sb, uid: data.user.id };
  sessions.set(label, s);
  return s;
}
const B = "signatures";
const created = []; // every object this run uploaded
const referenced = new Set();
const track = (p) => { created.push(p); return p; };
const txArgs = (seal, sig) => ({ p_origin_station: "KUL - MAA", p_direction: "OUTBOUND", p_route: "HUB", p_hub_destination: "PEN", p_vehicle_number: "E2E1234A", p_driver_name: "E2E Test Driver", p_driver_id: "E2ED001", p_seal_number: seal, p_signature_url: sig });
const tag = Date.now().toString().slice(-7);
const delArgs = (seal, sig) => ({ p_station_code: "PEN", p_driver_name: "E2E Vendor Driver", p_driver_nric: "E2E-NRIC-001", p_vehicle_registration_no: `E2EV${tag}`, p_seal_number: seal, p_signature_url: sig });
const rpcResult = (r) => ({ outcome: classifyError(r.error, r.status), error: r.error ?? null });
// a read/sign/remove counts as DENIED only for a genuine refusal; any other error is a setup fault (counted separately, never a pass)
// Storage answers a read/sign/move of an object the caller's RLS hides (or has no UPDATE policy for) with 404 "Object not found". That is a denial ONLY because this run has
// already proven the objects exist (each owner uploaded its own and downloaded it back), so a 404 on a KNOWN object is credited; any other fault is counted as a setup error.
let objectsKnownToExist = false;
const denied = (r) => { const c = classifyError(r.error, r.error?.statusCode ?? r.status); if (c === "authorization") return true; if (c === "setup" && objectsKnownToExist && /not found/i.test(String(r.error?.message ?? ""))) return true; if (c === "setup") rec.state.setupErrors += 1; return false; };

try {
  const drv = await S("caterlink-driver"), vnd = await S("caterlink-vendor"), aso = await S("aso"), kul = await S("aso-kul"), mgmt = await S("caterlink_management");

  // ---------- authorised uploads: the caller's own id, a documented prefix ----------
  const pDrv = track(bound.partA(drv.uid)), pVnd = track(bound.vendorA(vnd.uid));
  rec.expectOk("Driver: part-a/<own uid>/<uuid>.png upload succeeds", await uploadBound(drv, pDrv));
  rec.expectOk("Vendor: vendor-signatures/<own uid>/<uuid>.png upload succeeds", await uploadBound(vnd, pVnd));

  // ---------- unrecognised, cross-user and legacy-style names are refused at Storage RLS (the regression this phase fixes) ----------
  for (const [label, s] of [["Driver", drv], ["Vendor", vnd], ["PEN officer", aso], ["KUL officer", kul], ["Management", mgmt]]) {
    for (const name of [`arbitrary-test/${bound.partA(s.uid).slice(-40)}`, `e2e-probe/${label.replace(/\s/g, "-")}-${tag}.png`, `part-a/${Date.now()}-abcd1234.png`]) {
      rec.expectAuthorizationDenied(`${label}: upload of an unrecognised name (${name.split("/")[0]}) is refused`, await uploadBound(s, track(name)));
    }
  }
  rec.expectAuthorizationDenied("Driver cannot upload under the Vendor's id", await uploadBound(drv, track(bound.partA(vnd.uid))));
  rec.expectAuthorizationDenied("Vendor cannot upload under the Driver's id", await uploadBound(vnd, track(bound.vendorA(drv.uid))));
  rec.expectAuthorizationDenied("PEN officer cannot use the Driver prefix", await uploadBound(aso, track(bound.partA(aso.uid))));
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  rec.expectAuthorizationDenied("anon: upload is refused", await uploadBound({ sb: anon }, track(bound.partA(drv.uid))));

  // ---------- own object: immutable (no overwrite / upsert / move / delete) ----------
  const overwrite = await drv.sb.storage.from(B).upload(pDrv, PNG_BYTES, { contentType: "image/png", upsert: true });
  rec.expectAuthorizationDenied("Driver: overwriting its own object (upsert) is refused", { outcome: classifyError(overwrite.error, overwrite.error?.statusCode), error: overwrite.error });
  const rm = await drv.sb.storage.from(B).remove([pDrv]);
  rec.check("Driver: deleting its own object through the API removes nothing", rm.error ? denied(rm) : (rm.data ?? []).length === 0);

  rec.check("Driver: its own object downloads (the object exists)", !(await drv.sb.storage.from(B).download(pDrv)).error);
  rec.check("Vendor: its own object downloads (the object exists)", !(await vnd.sb.storage.from(B).download(pVnd)).error);
  objectsKnownToExist = true;
  const mv = await drv.sb.storage.from(B).move(pDrv, track(bound.partA(drv.uid)));
  rec.check("Driver: moving its own object is refused (no UPDATE policy)", mv.error ? denied(mv) : false);

  // ---------- list / download / signed URL across parties (reads are scoped: own upload or a visible referencing checkpoint) ----------
  const all = { driver: pDrv, vendor: pVnd };
  const matrix = [["caterlink-driver", "driver"], ["caterlink-vendor", "vendor"], ["aso", null], ["caterlink_management", null], ["operation_manager", null], ["profiling_aso", null], ["aso-jhb", null]];
  for (const [label, own] of matrix) {
    const sb = (await S(label)).sb;
    let dl = 0, signed = 0;
    for (const [k, p] of Object.entries(all)) {
      if (k === own) continue;
      if (!denied(await sb.storage.from(B).download(p))) dl += 1;
      if (!denied(await sb.storage.from(B).createSignedUrl(p, 60))) signed += 1;
    }
    rec.check(`${label}: DOWNLOAD / SIGNED URL of objects that are neither its own nor referenced by a checkpoint it can see are denied`, dl === 0 && signed === 0, `dl=${dl} signed=${signed}`);
    if (own) rec.check(`${label}: its own object downloads and signs`, !(await sb.storage.from(B).download(all[own])).error && !(await sb.storage.from(B).createSignedUrl(all[own], 60)).error);
  }
  const aList = await anon.storage.from(B).list(`part-a/${drv.uid}`);
  rec.check("anon: LIST shows nothing", (aList.data ?? []).length === 0);
  rec.check("anon: DOWNLOAD and SIGNED URL are denied", !!(await anon.storage.from(B).download(pDrv)).error && !!(await anon.storage.from(B).createSignedUrl(pDrv, 60)).error);

  // ---------- legitimate workflow: a referenced signature is reachable by exactly the authorised parties ----------
  const tx = await drv.sb.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-ST-${tag}`, pDrv));
  rec.expectOk("Driver created a movement referencing its own uploaded signature", rpcResult(tx));
  if (!tx.error) referenced.add(pDrv);
  const can = async (label, p) => !(await (await S(label)).sb.storage.from(B).createSignedUrl(p, 60)).error;
  rec.check("authorised: Driver (creator), Management, Operation Manager, the KUL origin officer and the PEN destination officer can sign the movement signature", (await can("caterlink-driver", pDrv)) && (await can("caterlink_management", pDrv)) && (await can("operation_manager", pDrv)) && (await can("aso-kul", pDrv)) && (await can("aso", pDrv)));
  rec.check("denied: Vendor and the JHB officer (a station that is neither origin nor destination) cannot sign the movement signature", !(await can("caterlink-vendor", pDrv)) && !(await can("aso-jhb", pDrv)));
  // OBSERVATION (pre-existing station read rule, unchanged by these migrations): any active assignment at the origin or destination station, Staff Profiling included, can read the movement and so its signature
  console.log(`OBSERVATION: Staff Profiling at the destination station can sign the movement signature: ${await can("profiling_aso", pDrv)}`);
  const del = await vnd.sb.rpc("create_caterlink_vendor_delivery_secure", delArgs(`E2E-VS-${tag}`, pVnd));
  rec.expectOk("Vendor created a delivery referencing its own uploaded signature", rpcResult(del));
  if (!del.error) referenced.add(pVnd);
  rec.check("authorised: Vendor (owner), Management and the PEN officer can sign the vendor signature", (await can("caterlink-vendor", pVnd)) && (await can("caterlink_management", pVnd)) && (await can("aso", pVnd)));
  rec.check("denied: Driver, JHB officer and KUL officer cannot sign the vendor signature", !(await can("caterlink-driver", pVnd)) && !(await can("aso-jhb", pVnd)) && !(await can("aso-kul", pVnd)));

  // ---------- finalisation binding: another party's object, a reused object and an unbound name are all refused ----------
  const stolen = await drv.sb.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-STEAL-${tag}`, pVnd));
  rec.expectAuthorizationDenied("a Driver cannot create a record that references the Vendor's signature object", rpcResult(stolen), /not the one uploaded|not uploaded by this account/i);
  const reuse = await drv.sb.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-REUSE-${tag}`, pDrv));
  rec.expectAuthorizationDenied("an object that already backs a movement cannot back a second record (single use)", rpcResult(reuse), /already been used/i);
  const unbound = await drv.sb.rpc("create_caterlink_driver_transaction_secure", txArgs(`E2E-UNBOUND-${tag}`, `part-a/${Date.now()}-abcd1234.png`));
  rec.expectAuthorizationDenied("a record cannot reference an unbound legacy-style name", rpcResult(unbound), /not the one uploaded/i);
  rec.check("and none of the refused references made either object readable", !(await can("caterlink-vendor", pDrv)) && !(await can("caterlink-driver", pVnd)));
} catch (e) {
  if (e instanceof SetupError) { rec.state.setupErrors += 1; console.log(`INCONCLUSIVE: ${e.message}`); } else throw e;
} finally {
  // remove only what THIS run created and nothing references (service role is used for cleanup, never for a verdict)
  await cleanupOwnOrphans(admin, B);
  console.log(`${referenced.size} referenced object(s) remain (the certification fixtures)`);
}
fs.writeFileSync(path.join(os.tmpdir(), "vecta-storage-probe-fixtures.json"), JSON.stringify({ tag, referenced: [...referenced] }), { mode: 0o600 });
console.log(rec.summary());
process.exit(rec.exitCode());
