/**
 * ICMS seed script (Phase 1: direction-aware).
 *
 * Creates the demo accounts (one per role, including SRA Warehouse PIC)
 * plus sample transactions in every workflow state for both directions.
 *
 * OUTBOUND: A -> B (In-flight Post) -> C (Airport Post) -> D
 * INBOUND:  A -> C (Airport Post)  -> B (In-flight Post, final)
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed.mjs
 * or put both values in .env.local and run: node scripts/seed.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env.local loader so the script works without extra deps.
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey || url.includes("placeholder")) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in env or .env.local) first."
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const USERS = [
  { email: "pic@icms.local", name: "Ahmad Warehouse", staff_id: "WH-1001", role: "warehouse_pic" },
  { email: "sra@icms.local", name: "Nurul SRA Warehouse", staff_id: "SW-4001", role: "warehouse_pic" },
  { email: "post2@icms.local", name: "Siti Post Two", staff_id: "AV-2001", role: "post2_avsec" },
  { email: "post6@icms.local", name: "Kumar Post Six", staff_id: "AV-6001", role: "post6_avsec" },
  { email: "receiver@icms.local", name: "Lee Receiver", staff_id: "SR-3001", role: "receiver" },
  // Internal DB role value stays 'supervisor' (see ROLE_LABELS) — only the
  // display label and demo email/name reflect the "Admin" rename.
  { email: "admin@icms.local", name: "Farah Admin", staff_id: "SV-9001", role: "supervisor" },
];

const PASSWORD = "ICMS-demo-2026!";

async function ensureUser(u) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: PASSWORD,
    email_confirm: true,
  });

  let authId = created?.user?.id;
  if (error) {
    const { data: list, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (listErr) throw listErr;
    const existing = list.users.find((x) => x.email === u.email);
    if (!existing) throw error;
    authId = existing.id;
  }

  const { error: upsertErr } = await admin.from("users").upsert(
    {
      id: authId,
      name: u.name,
      staff_id: u.staff_id,
      email: u.email,
      role: u.role,
    },
    { onConflict: "id" }
  );
  if (upsertErr) throw upsertErr;
  console.log(`user ready: ${u.email} (${u.role})`);
  return authId;
}

// 1x1 transparent PNG used as a placeholder signature in seed records.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

async function uploadSignature(name) {
  const path = `seed/${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
  const { error } = await admin.storage
    .from("signatures")
    .upload(path, PIXEL, { contentType: "image/png" });
  if (error) throw error;
  return path;
}

async function insertPartB(txId, ids) {
  const { error } = await admin.from("part_b").insert({
    transaction_id: txId,
    avsec_name: "Siti Post Two",
    avsec_staff_id: "AV-2001",
    vehicle_verified: true,
    driver_verified: true,
    seal_verified: true,
    signature_url: await uploadSignature("part-b"),
    completed_by: ids.post2_avsec,
  });
  if (error) throw error;
}

async function insertPartC(txId, ids) {
  const { error } = await admin.from("part_c").insert({
    transaction_id: txId,
    avsec_name: "Kumar Post Six",
    avsec_staff_id: "AV-6001",
    vehicle_verified: true,
    driver_verified: true,
    seal_verified: true,
    signature_url: await uploadSignature("part-c"),
    completed_by: ids.post6_avsec,
  });
  if (error) throw error;
}

/**
 * stage = number of checkpoint steps already completed after Part A,
 * or "ESCALATED" to raise an incident at the current point.
 */
async function createTransaction(ids, direction, steps, overrides = {}) {
  const creator =
    direction === "OUTBOUND" ? ids["pic@icms.local"] : ids["sra@icms.local"];
  const picName = direction === "OUTBOUND" ? "Ahmad Warehouse" : "Nurul SRA Warehouse";
  const picStaffId = direction === "OUTBOUND" ? "WH-1001" : "SW-4001";

  const { data: tx, error } = await admin
    .from("transactions")
    .insert({
      direction,
      vehicle_number: overrides.vehicle_number ?? "WKD 4521",
      driver_name: overrides.driver_name ?? "Rahman bin Ali",
      driver_id: overrides.driver_id ?? "DRV-0091",
      seal_number: overrides.seal_number ?? `SEAL-${Math.floor(Math.random() * 90000) + 10000}`,
      created_by: creator,
    })
    .select()
    .single();
  if (error) throw error;

  const { error: sealErr } = await admin.from("seals").insert({
    transaction_id: tx.id,
    seal_number: tx.seal_number,
    seal_type: "TRUCK_SEAL",
    seal_color: direction === "OUTBOUND" ? "BLUE" : "GREEN",
  });
  if (sealErr) throw sealErr;

  const { error: aErr } = await admin.from("part_a").insert({
    transaction_id: tx.id,
    pic_name: picName,
    pic_staff_id: picStaffId,
    vehicle_search_completed: true,
    signature_url: await uploadSignature("part-a"),
    remarks: "Seed data",
    completed_by: creator,
  });
  if (aErr) throw aErr;

  // Direction-aware checkpoint order.
  const order =
    direction === "OUTBOUND"
      ? [() => insertPartB(tx.id, ids), () => insertPartC(tx.id, ids), () => insertPartD(tx.id, ids)]
      : [() => insertPartC(tx.id, ids), () => insertPartB(tx.id, ids)];

  const numSteps = steps === "ESCALATED" ? 0 : steps;
  for (let i = 0; i < numSteps && i < order.length; i++) {
    await order[i]();
  }

  if (steps === "ESCALATED") {
    const { error: iErr } = await admin.from("incidents").insert({
      transaction_id: tx.id,
      incident_type: "SEAL_MISMATCH",
      description: "Seed incident: seal number does not match Part A record.",
      reported_by: "Kumar Post Six (AV-6001)",
      reported_by_id: ids.post6_avsec,
    });
    if (iErr) throw iErr;
  }

  return tx;
}

async function insertPartD(txId, ids) {
  const { error } = await admin.from("part_d").insert({
    transaction_id: txId,
    delivery_location: "AIRCRAFT",
    receiver_name: "Lee Receiver",
    receiver_staff_id: "SR-3001",
    seal_intact: true,
    signature_url: await uploadSignature("part-d"),
    completed_by: ids.receiver,
  });
  if (error) throw error;
}

async function main() {
  const ids = {};
  for (const u of USERS) {
    const id = await ensureUser(u);
    // Keyed by both role and email: the two warehouse accounts now share
    // the single warehouse_pic role, so email is what tells them apart.
    ids[u.role] = id;
    ids[u.email] = id;
  }

  const samples = [
    ["OUTBOUND", 0, { vehicle_number: "WKD 4521" }],
    ["OUTBOUND", 1, { vehicle_number: "WMA 7733" }],
    ["OUTBOUND", 2, { vehicle_number: "WTF 1289" }],
    ["OUTBOUND", 3, { vehicle_number: "WXY 5566" }],
    ["OUTBOUND", "ESCALATED", { vehicle_number: "WBB 3020" }],
    ["INBOUND", 0, { vehicle_number: "WQA 9014" }],
    ["INBOUND", 1, { vehicle_number: "WPP 6612" }],
    ["INBOUND", 2, { vehicle_number: "WRR 8874" }],
  ];

  for (const [direction, steps, overrides] of samples) {
    const tx = await createTransaction(ids, direction, steps, overrides);
    console.log(`transaction ${tx.transaction_number} (${direction}, steps=${steps})`);
  }

  console.log("\nSeed complete. Demo accounts (password: " + PASSWORD + "):");
  for (const u of USERS) console.log(`  ${u.role.padEnd(18)} ${u.email}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
