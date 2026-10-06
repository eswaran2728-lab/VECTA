#!/usr/bin/env node
// Documents the OPEN signature-bucket finding on staging with the real policies and real external accounts.
// Uploads two clearly marked probe objects with the staging admin context (users cannot upload: separate defect),
// checks what a Driver and a Vendor can list and download, then ALWAYS removes the probes. Prints counts only.
//   node --env-file=.env.local scripts/staging/probe-signature-exposure.mjs
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";

const ctx = resolveStagingAdminContext();
const admin = ctx.client;
const creds = loadCurrentCredentials();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const stamp = Date.now();
const probes = [`e2e-probe/driver-private-${stamp}.png`, `e2e-probe/vendor-private-${stamp}.png`];
let failures = 0;
const check = (l, ok, note = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}: ${l}${note ? " -- " + note : ""}`); };
try {
  for (const p of probes) {
    const up = await admin.storage.from("signatures").upload(p, png, { contentType: "image/png" });
    if (up.error) throw new Error(`probe upload failed: ${up.error.message}`);
  }
  for (const label of ["caterlink-driver", "caterlink-vendor"]) {
    const c = creds.find((a) => a.label === label);
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error } = await signInWithRetry(sb, c.email, c.password);
    if (error) throw new Error(`sign-in failed for ${label}`);
    const list = await sb.storage.from("signatures").list("e2e-probe", { limit: 100 });
    const seen = (list.data ?? []).map((o) => o.name);
    const mine = label === "caterlink-driver" ? probes[0] : probes[1];
    const theirs = label === "caterlink-driver" ? probes[1] : probes[0];
    check(`${label}: can LIST objects in the bucket that belong to nobody it may see`, seen.length >= 2, `${seen.length} listed`);
    const dl = await sb.storage.from("signatures").download(theirs);
    check(`${label}: can DOWNLOAD another party's object by path (finding is OPEN when this is true)`, !dl.error && !!dl.data, "EXPOSED");
    const signed = await sb.storage.from("signatures").createSignedUrl(theirs, 60);
    check(`${label}: can mint a signed URL for another party's object`, !signed.error && !!signed.data?.signedUrl, "EXPOSED");
    void mine;
  }
} finally {
  const rm = await admin.storage.from("signatures").remove(probes);
  const left = await admin.storage.from("signatures").list("e2e-probe", { limit: 100 });
  console.log(`probe cleanup: removed=${(rm.data ?? []).length} remaining=${(left.data ?? []).length}`);
}
console.log("These PASS lines document EXPOSURE (the finding), not a healthy state.");
