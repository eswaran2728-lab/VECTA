#!/usr/bin/env node
// READ-ONLY reproduction of the open profile-state visibility flaw on staging (see
// supabase/proposed-migrations/20261027000001_station_visibility_requires_approved_profile.sql).
// Signs in as the negative-state review accounts (their own sessions) and checks whether the Driver's E2E movement, its Part A
// and its seals are readable through the REST API. Changes nothing. Prints labels and booleans only.
//   node --env-file=.env.local scripts/staging/reproduce-profile-state-flaw.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { environmentGates } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

environmentGates();
const fx = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), "vecta-e2e-fixtures.json"), "utf8"));
const creds = loadCurrentCredentials();
const cases = [
  ["aso-kul", "approved, active assignment at KUL - MAA", true],
  ["neg-pending-profile", "profile PENDING, active assignment", "FLAW"],
  ["neg-rejected-profile", "profile REJECTED, active assignment", "FLAW"],
  ["neg-deactivated-profile", "profile DEACTIVATED, active assignment", "FLAW"],
  ["neg-revoked-assignment", "approved, assignment REVOKED", false],
  ["neg-expired-assignment", "approved, assignment EXPIRED", false],
  ["neg-future-assignment", "approved, assignment FUTURE-dated", false],
];
let unexpected = 0;
for (const [label, desc, expected] of cases) {
  const c = creds.find((a) => a.label === label);
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await signInWithRetry(sb, c.email, c.password);
  if (error) { console.log(`${label}: sign-in failed`); unexpected += 1; continue; }
  const t = (await sb.from("transactions").select("id").eq("id", fx.txId)).data?.length === 1;
  const a = (await sb.from("caterlink_checkpoint_part_a").select("id").eq("transaction_id", fx.txId)).data?.length === 1;
  const s = (await sb.from("seals").select("id").eq("transaction_id", fx.txId)).data?.length === 1;
  const readable = t && a && s;
  const verdict = expected === "FLAW" ? (readable ? "FLAW REPRODUCED (readable, should be denied)" : "denied (flaw not present)") : readable === expected ? (readable ? "readable (correct)" : "denied (correct)") : "UNEXPECTED";
  if (expected !== "FLAW" && readable !== expected) unexpected += 1;
  console.log(`${label.padEnd(26)} ${desc.padEnd(44)} movement=${t} partA=${a} seals=${s} => ${verdict}`);
}
console.log(unexpected ? `UNEXPECTED results: ${unexpected}` : "Only the three documented profile-state cases deviate from the intended policy.");
