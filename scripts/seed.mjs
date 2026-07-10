/**
 * CSCS seed script.
 *
 * Creates the five demo accounts (one per role) plus a handful of sample
 * transactions in every workflow state so the dashboard has data.
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
  { email: "pic@cscs.local", name: "Ahmad Warehouse", staff_id: "WH-1001", role: "warehouse_pic" },
  { email: "post2@cscs.local", name: "Siti Post Two", staff_id: "AV-2001", role: "post2_avsec" },
  { email: "post6@cscs.local", name: "Kumar Post Six", staff_id: "AV-6001", role: "post6_avsec" },
  { email: "receiver@cscs.local", name: "Lee Receiver", staff_id: "SR-3001", role: "receiver" },
  { email: "supervisor@cscs.local", name: "Farah Supervisor", staff_id: "SV-9001", role: "supervisor" },
];

const PASSWORD = "CSCS-demo-2026!";

async function ensureUser(u) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: u.email,
    password: PASSWORD,
    email_confirm: true,
  });

  let authId = created?.user?.id;
  if (error) {
    // Already exists -> look it up.
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
  const path = `seed/${name}-${Date.now()}.png`;
  const { error } = await admin.storage
    .from("signatures")
    .upload(path, PIXEL, { contentType: "image/png" });
  if (error) throw error;
  return path;
}

async function createTransaction(ids, stage, overrides = {}) {
  const { data: tx, error } = await admin
    .from("transactions")
    .insert({
      direction: overrides.direction ?? "WAREHOUSE_TO_AIRCRAFT",
      vehicle_number: overrides.vehicle_number ?? "WKD 4521",
      driver_name: overrides.driver_name ?? "Rahman bin Ali",
      driver_id: overrides.driver_id ?? "DRV-0091",
      seal_number: overrides.seal_number ?? `SEAL-${Math.floor(Math.random() * 90000) + 10000}`,
      created_by: ids.warehouse_pic,
    })
    .select()
    .single();
  if (error) throw error;

  await admin.from("part_a").insert({
    transaction_id: tx.id,
    pic_name: "Ahmad Warehouse",
    pic_staff_id: "WH-1001",
    vehicle_search_completed: true,
    signature_url: await uploadSignature("part-a"),
    remarks: "Seed data",
    completed_by: ids.warehouse_pic,
  });

  if (stage === "CREATED") return tx;

  const { error: bErr } = await admin.from("part_b").insert({
    transaction_id: tx.id,
    avsec_name: "Siti Post Two",
    avsec_staff_id: "AV-2001",
    vehicle_verified: true,
    driver_verified: true,
    seal_verified: true,
    signature_url: await uploadSignature("part-b"),
    completed_by: ids.post2_avsec,
  });
  if (bErr) throw bErr;
  if (stage === "POST2_APPROVED") return tx;

  const { error: cErr } = await admin.from("part_c").insert({
    transaction_id: tx.id,
    avsec_name: "Kumar Post Six",
    avsec_staff_id: "AV-6001",
    vehicle_verified: true,
    driver_verified: true,
    seal_verified: true,
    signature_url: await uploadSignature("part-c"),
    completed_by: ids.post6_avsec,
  });
  if (cErr) throw cErr;
  if (stage === "POST6_APPROVED") return tx;

  if (stage === "ESCALATED") {
    const { error: iErr } = await admin.from("incidents").insert({
      transaction_id: tx.id,
      incident_type: "SEAL_MISMATCH",
      description: "Seed incident: seal number does not match Part A record.",
      reported_by: "Kumar Post Six",
      reported_by_id: ids.post6_avsec,
    });
    if (iErr) throw iErr;
    return tx;
  }

  const { error: dErr } = await admin.from("part_d").insert({
    transaction_id: tx.id,
    delivery_location: "AIRCRAFT",
    receiver_name: "Lee Receiver",
    receiver_staff_id: "SR-3001",
    seal_intact: true,
    signature_url: await uploadSignature("part-d"),
    completed_by: ids.receiver,
  });
  if (dErr) throw dErr;
  return tx;
}

async function main() {
  const ids = {};
  for (const u of USERS) {
    ids[u.role] = await ensureUser(u);
  }

  const stages = [
    ["CREATED", { vehicle_number: "WKD 4521" }],
    ["POST2_APPROVED", { vehicle_number: "WMA 7733" }],
    ["POST6_APPROVED", { vehicle_number: "WTF 1289" }],
    ["COMPLETED", { vehicle_number: "WXY 5566" }],
    ["COMPLETED", { vehicle_number: "WQA 9014", direction: "AIRCRAFT_TO_WAREHOUSE" }],
    ["ESCALATED", { vehicle_number: "WBB 3020" }],
  ];

  for (const [stage, overrides] of stages) {
    const tx = await createTransaction(ids, stage, overrides);
    console.log(`transaction ${tx.transaction_number} -> ${stage}`);
  }

  console.log("\nSeed complete. Demo accounts (password: " + PASSWORD + "):");
  for (const u of USERS) console.log(`  ${u.role.padEnd(14)} ${u.email}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
