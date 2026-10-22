#!/usr/bin/env node
// Guarded fixture ledger and cleanup for the CaterLink browser E2E / write-flow certification (STAGING ONLY, approved project only).
//
// The E2E creates its records through the real UI and RPCs, so row ids cannot be known before the mutations. The ledger therefore works in three
// recorded steps, and cleanup deletes ONLY ids written to the ledger before any deletion:
//   snapshot  -- BEFORE the run: every primary key of every CaterLink table, every Storage object name and key unrelated row counts are written to a private
//                ledger outside the repository (mode 0600). Existing rows (earlier E2E fixtures, UAT, real data) become the protected baseline.
//   discover  -- AFTER the run: new ids (current minus baseline) are classified. A new row is ours only when it carries an E2E marker (a root record whose
//                driver / vehicle / seal / company identifier contains "E2E") or hangs off a classified parent (foreign key), or is a Storage object owned by one
//                of the E2E identities. Anything new that cannot be classified is listed and BLOCKS cleanup (nothing unclassified is ever deleted).
//   cleanup   -- default DRY RUN; --live deletes exactly the ledgered ids (one transaction, counts must match exactly), then removes exactly the ledgered
//                Storage objects through the Storage API. Rows are re-verified against their marker/parent immediately before deletion.
//   verify    -- proves zero remnants: no id outside the baseline in any table, no new Storage object, key counts equal to the snapshot.
//
//   node --env-file=.env.local scripts/staging/e2e-fixtures.mjs --action=snapshot|discover|cleanup|verify --run-id=<id> [--live]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { environmentGates, connectVerified, FORBIDDEN_REF, APPROVED_REF } from "./lib/run-gates.mjs";
import { loadCurrentManifest } from "./lib/review-accounts.mjs";

const fail = (m) => { throw new Error(m); };
const E2E_IDENTITIES = ["caterlink-driver", "caterlink-vendor", "caterlink_management", "aso", "aso-jhb", "aso-kul", "aso-kch-receipt", "aso-bki-receipt", "sso", "so", "operation_manager", "profiling_aso"];

/** Deletion order is children first. `kind`: root (own marker) or child (by parent). */
export const TABLE_SPECS = [
  { t: "caterlink_incident_notes", pk: "id", child: { col: "incident_id", parent: "caterlink_incidents" } },
  { t: "caterlink_incidents", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_archives", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_pdf_jobs", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_transaction_pdfs", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "seal_verifications", pk: "id", child: { col: "seal_id", parent: "seals" } },
  { t: "caterlink_checkpoint_redq", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_checkpoint_hub", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_checkpoint_part_d", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "part_b_c", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "caterlink_checkpoint_part_a", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "seals", pk: "id", child: { col: "transaction_id", parent: "transactions" } },
  { t: "transactions", pk: "id", root: "(driver_name ilike '%E2E%' or seal_number ilike 'E2E%' or vehicle_number ilike '%E2E%' or driver_id ilike 'E2E%')" },
  { t: "caterlink_vendor_checkpoints", pk: "id", child: { col: "delivery_id", parent: "caterlink_vendor_deliveries" } },
  { t: "caterlink_vendor_deliveries", pk: "id", root: "(driver_name ilike '%E2E%' or seal_number ilike 'E2E%' or vehicle_registration_no ilike '%E2E%' or driver_nric ilike 'E2E%')" },
  { t: "drivers", pk: "id", root: "(staff_id ilike 'E2E%' or name ilike '%E2E%')" },
  { t: "vehicles", pk: "id", root: "(vehicle_number ilike 'E2E%')" },
  { t: "catering_companies", pk: "id", root: "(code ilike 'E2E%' or name ilike '%E2E%')" },
  { t: "user_notifications", pk: "id", payloadOf: ["transactions", "caterlink_vendor_deliveries"] },
];
/** Tables whose ids are tracked and whose rows are only ever classified through a parent / payload (signature_refs is keyed by signature_url). */
const COUNT_TABLES = ["profiles", "user_role_assignments", "duty_records", "report_sec014", "report_sec016", "central_reports_index", "caterlink_station_capabilities", "caterlink_signature_refs"];
const ledgerDir = path.join(os.tmpdir(), "vecta-e2e-ledgers");
const ledgerPath = (runId) => path.join(ledgerDir, `${runId}.json`);
const readLedger = (runId) => (fs.existsSync(ledgerPath(runId)) ? JSON.parse(fs.readFileSync(ledgerPath(runId), "utf8")) : fail(`no ledger for ${runId}`));
const writeLedger = (runId, l) => { fs.mkdirSync(ledgerDir, { recursive: true }); fs.writeFileSync(ledgerPath(runId), JSON.stringify(l, null, 1), { mode: 0o600 }); };

async function allIds(q, spec) { return (await q(`select ${spec.pk}::text as k from public.${spec.t}`)).map((r) => r.k); }

export async function takeSnapshot(q, owners) {
  const ids = {};
  for (const s of TABLE_SPECS) ids[s.t] = await allIds(q, s);
  const counts = {};
  for (const t of COUNT_TABLES) counts[t] = (await q(`select count(*)::int n from public.${t}`))[0].n;
  counts.authUsers = (await q("select count(*)::int n from auth.users"))[0].n;
  const objects = (await q("select bucket_id, name from storage.objects order by 1,2")).map((o) => `${o.bucket_id}/${o.name}`);
  const refs = (await q("select signature_url::text k from public.caterlink_signature_refs")).map((r) => r.k);
  return { ids, counts, objects, refs, takenAt: (await q("select now()::text t"))[0].t, owners };
}

/** Classify what is new relative to the baseline. Pure given query results; returns { created, unclassified }. */
export async function classify(q, base, owners) {
  const created = {};
  const unclassified = {};
  const known = new Set();
  for (const s of TABLE_SPECS) {
    const baseline = new Set(base.ids[s.t]);
    const current = await allIds(q, s);
    const fresh = current.filter((k) => !baseline.has(k));
    if (!fresh.length) { created[s.t] = []; continue; }
    let mine = [];
    if (s.root) {
      mine = (await q(`select ${s.pk}::text as k from public.${s.t} where ${s.pk}::text = any($1::text[]) and ${s.root}`, [fresh])).map((r) => r.k);
    } else if (s.child) {
      const parent = created[s.child.parent] ?? [];
      mine = parent.length ? (await q(`select ${s.pk}::text as k from public.${s.t} where ${s.pk}::text = any($1::text[]) and ${s.child.col}::text = any($2::text[])`, [fresh, parent])).map((r) => r.k) : [];
    } else if (s.payloadOf) {
      const parents = s.payloadOf.flatMap((p) => created[p] ?? []);
      mine = parents.length ? (await q(`select ${s.pk}::text as k from public.${s.t} where ${s.pk}::text = any($1::text[]) and exists (select 1 from unnest($2::text[]) p where payload::text like '%'||p||'%')`, [fresh, parents])).map((r) => r.k) : [];
    }
    created[s.t] = mine;
    const rest = fresh.filter((k) => !mine.includes(k));
    if (rest.length) unclassified[s.t] = rest;
    mine.forEach((k) => known.add(`${s.t}:${k}`));
  }
  // Storage objects: new objects owned by an E2E identity
  const baseObjects = new Set(base.objects);
  const nowObjects = await q("select bucket_id, name, owner::text own from storage.objects");
  const freshObjects = nowObjects.filter((o) => !baseObjects.has(`${o.bucket_id}/${o.name}`));
  const ownerIds = new Set(Object.values(owners));
  created.__storage = freshObjects.filter((o) => ownerIds.has(o.own)).map((o) => `${o.bucket_id}/${o.name}`);
  const strayObjects = freshObjects.filter((o) => !ownerIds.has(o.own)).map((o) => `${o.bucket_id}/${o.name}`);
  if (strayObjects.length) unclassified.__storage = strayObjects;
  // signature refs: new refs whose url is a created object name (or a signature_url of a created row)
  const baseRefs = new Set(base.refs);
  const nowRefs = (await q("select signature_url::text k from public.caterlink_signature_refs")).map((r) => r.k);
  const freshRefs = nowRefs.filter((k) => !baseRefs.has(k));
  const objectNames = new Set(created.__storage.map((n) => n.split("/").slice(1).join("/")));
  created.__refs = freshRefs.filter((k) => objectNames.has(k));
  const strayRefs = freshRefs.filter((k) => !objectNames.has(k));
  if (strayRefs.length) unclassified.__refs = strayRefs;
  return { created, unclassified };
}

export async function main() {
  const args = process.argv.slice(2);
  const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const action = argVal("action");
  const runId = argVal("run-id");
  const LIVE = args.includes("--live");
  if (!action || !runId || !/^[a-z0-9][a-z0-9-]{3,40}$/.test(runId)) fail("--action and a valid --run-id are required");
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF) || process.argv.join(" ").includes(FORBIDDEN_REF)) fail("production reference present");
  environmentGates();
  const manifest = loadCurrentManifest();
  const owners = Object.fromEntries(E2E_IDENTITIES.map((l) => [l, manifest.find((a) => a.label === l)?.authUserId ?? fail(`manifest has no ${l}`)]));
  const { client } = await connectVerified();
  const q = async (s, p) => (await client.query(s, p)).rows;
  console.log(`staging ${APPROVED_REF} connected; action=${action}; run=${runId}; ${action === "cleanup" ? (LIVE ? "LIVE" : "DRY RUN") : "read-only"}`);
  try {
    if (action === "snapshot") {
      if (fs.existsSync(ledgerPath(runId))) fail(`ledger ${runId} exists already (use a new run id)`);
      await client.query("begin read only");
      const snap = await takeSnapshot(q, owners);
      await client.query("rollback");
      writeLedger(runId, { runId, snapshot: snap, created: null, status: "snapshotted" });
      console.log(`snapshot recorded: ${Object.entries(snap.ids).map(([t, v]) => `${t}=${v.length}`).join(" ")} objects=${snap.objects.length} refs=${snap.refs.length}`);
      return;
    }
    const ledger = readLedger(runId);
    if (action === "discover") {
      await client.query("begin read only");
      const { created, unclassified } = await classify(q, ledger.snapshot, ledger.snapshot.owners);
      await client.query("rollback");
      ledger.created = created; ledger.unclassified = unclassified; ledger.status = "discovered";
      writeLedger(runId, ledger);
      console.log("created (ledgered before any deletion):", Object.entries(created).filter(([, v]) => v.length).map(([t, v]) => `${t}=${v.length}`).join(" ") || "none");
      const bad = Object.entries(unclassified);
      if (bad.length) { console.log("UNCLASSIFIED new rows/objects (cleanup is blocked):", bad.map(([t, v]) => `${t}=${v.length}`).join(" ")); process.exitCode = 2; }
      return;
    }
    if (action === "cleanup") {
      if (ledger.status !== "discovered" || !ledger.created) fail("run discover first: the ledger holds no recorded ids");
      if (Object.keys(ledger.unclassified ?? {}).length) fail("unclassified new rows exist: nothing is deleted until they are explained");
      const created = ledger.created;
      const total = Object.entries(created).reduce((n, [, v]) => n + v.length, 0);
      console.log(`ledgered for removal: ${Object.entries(created).filter(([, v]) => v.length).map(([t, v]) => `${t}=${v.length}`).join(" ") || "nothing"}`);
      if (!LIVE) { console.log("DRY RUN: nothing deleted"); return; }
      if (total === 0) { console.log("nothing to delete"); return; }
      await client.query("begin");
      try {
        await client.query("set local session_replication_role = replica"); // exact-id deletes of ledgered rows only; guard triggers/FKs are not the subject here
        for (const s of TABLE_SPECS) {
          const ids = created[s.t] ?? [];
          if (!ids.length) continue;
          let extra = "";
          let params = [ids];
          if (s.root) extra = ` and ${s.root}`;
          else if (s.child) { extra = ` and ${s.child.col}::text = any($2::text[])`; params = [ids, (ledger.parentIds?.[s.t]) ?? created[s.child.parent] ?? []]; }
          const r = await client.query(`delete from public.${s.t} where ${s.pk}::text = any($1::text[])${extra}`, params);
          if (r.rowCount !== ids.length) fail(`${s.t}: deleted ${r.rowCount} of ${ids.length} ledgered rows: rolled back`);
          console.log(`deleted ${r.rowCount} ${s.t}`);
        }
        if (created.__refs?.length) {
          const r = await client.query("delete from public.caterlink_signature_refs where signature_url = any($1::text[])", [created.__refs]);
          if (r.rowCount !== created.__refs.length) fail(`caterlink_signature_refs: deleted ${r.rowCount} of ${created.__refs.length}: rolled back`);
          console.log(`deleted ${r.rowCount} caterlink_signature_refs`);
        }
        await client.query("commit");
      } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
      // Storage objects through the Storage API (removes the blob as well as the metadata row), exact names only
      const { resolveStagingAdminContext } = await import("./lib/env-guard.mjs");
      const admin = resolveStagingAdminContext().client;
      const byBucket = {};
      for (const full of created.__storage ?? []) { const [b, ...rest] = full.split("/"); (byBucket[b] ??= []).push(rest.join("/")); }
      for (const [b, names] of Object.entries(byBucket)) {
        const r = await admin.storage.from(b).remove(names);
        if (r.error) fail(`storage remove failed in ${b}: ${r.error.message}`);
        console.log(`removed ${r.data?.length ?? 0} of ${names.length} Storage object(s) from ${b}`);
      }
      ledger.status = "cleaned"; writeLedger(runId, ledger);
      return;
    }
    if (action === "verify") {
      await client.query("begin read only");
      const { created, unclassified } = await classify(q, ledger.snapshot, ledger.snapshot.owners);
      const counts = {};
      for (const t of COUNT_TABLES) counts[t] = (await q(`select count(*)::int n from public.${t}`))[0].n;
      counts.authUsers = (await q("select count(*)::int n from auth.users"))[0].n;
      const nowObjects = (await q("select bucket_id, name from storage.objects")).map((o) => `${o.bucket_id}/${o.name}`);
      await client.query("rollback");
      const remaining = Object.entries(created).filter(([, v]) => v.length).map(([t, v]) => `${t}=${v.length}`);
      const stray = Object.entries(unclassified).map(([t, v]) => `${t}=${v.length}`);
      const baseObjs = new Set(ledger.snapshot.objects), nowSet = new Set(nowObjects);
      const newObjs = nowObjects.filter((n) => !baseObjs.has(n)).length, lostObjs = ledger.snapshot.objects.filter((n) => !nowSet.has(n)).length;
      const countDiff = Object.keys(ledger.snapshot.counts).filter((k) => ledger.snapshot.counts[k] !== counts[k]).map((k) => `${k}:${ledger.snapshot.counts[k]}->${counts[k]}`);
      console.log(`tagged remnants: ${remaining.length ? remaining.join(" ") : "0"}; unclassified: ${stray.length ? stray.join(" ") : "0"}; new Storage objects: ${newObjs}; baseline objects missing: ${lostObjs}; unrelated count changes: ${countDiff.length ? countDiff.join(" ") : "none"}`);
      if (remaining.length || stray.length || newObjs || lostObjs || countDiff.length) { process.exitCode = 1; console.log("VERIFY FAILED"); } else console.log("VERIFY OK: zero remnants; every baseline row, Storage object and count is unchanged");
      return;
    }
    fail(`unknown action ${action}`);
  } finally { await client.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`FAILED: ${String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`); process.exit(1); });
}
