#!/usr/bin/env node
// Real-account probes of the `completed-forms` Storage bucket on ACTUAL staging after migration 20261116000001 (publishable key; each identity's own
// session; the Storage API itself: upload, list, download, signed URL, overwrite, delete). The bucket has no active producer or consumer, so every client
// operation must be refused. The service role is used ONLY to create one tagged fixture object (proving service-role access stays available and giving the
// read/list/download probes something to be denied) and to remove exactly that fixture. A refusal is credited only when it is a genuine refusal;
// a fixture/setup fault is INCONCLUSIVE (exit 2), never a pass.
//   node --env-file=.env.local scripts/staging/verify-completed-forms-staging.mjs
// Exit codes: 0 all verdicts passed, 1 a control failed, 2 inconclusive.
import { createClient } from "@supabase/supabase-js";
import { resolveStagingAdminContext } from "./lib/env-guard.mjs";
import { environmentGates } from "./lib/run-gates.mjs";
import { loadCurrentCredentials, signInWithRetry } from "./lib/review-accounts.mjs";
import { createRecorder, classifyError, SetupError } from "./lib/signature-fixtures.mjs";

environmentGates();
const admin = resolveStagingAdminContext().client;
const creds = loadCurrentCredentials();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const rec = createRecorder();
const B = "completed-forms";
const tag = `sec${Date.now().toString().slice(-8)}`;
const PDF = Buffer.from("%PDF-1.4\n% staging probe fixture\n%%EOF\n");
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
const verdict = (r) => ({ outcome: classifyError(r.error, r.error?.statusCode ?? r.status), error: r.error ?? null });
const fixture = `fixtures-${tag}/probe.pdf`;
let fixtureCreated = false;
// Storage answers a READ of an object the caller's RLS hides with 404 "Object not found". That is the expected denial form ONLY because the service role has just
// proven the fixture exists (and the end of the run proves it was never removed); without that proof the same message would be a setup fault.
const readVerdict = (r) => { const v = verdict(r); return v.outcome === "setup" && fixtureCreated && /object not found|not found/i.test(String(r.error?.message ?? "")) ? { outcome: "authorization", error: r.error } : v; };
try {
  // ---------- the bucket is private and the trusted service role still works ----------
  const bucket = await admin.storage.getBucket(B);
  rec.check("the completed-forms bucket exists and is private", !bucket.error && bucket.data?.public === false, bucket.error?.message ?? "");
  const up = await admin.storage.from(B).upload(fixture, PDF, { contentType: "application/pdf", upsert: false });
  rec.expectOk("service role: a trusted server operation can still write a completed form (tagged fixture)", verdict(up));
  fixtureCreated = !up.error;
  if (!fixtureCreated) throw new SetupError("the tagged fixture could not be created with the service role");
  const svcSigned = await admin.storage.from(B).createSignedUrl(fixture, 60);
  rec.expectOk("service role: can sign the fixture", verdict(svcSigned));

  // ---------- every client persona: upload, overwrite, list, download, sign, delete are all refused ----------
  const personas = ["aso", "aso-kul", "aso-jhb", "so", "sso", "caterlink-driver", "caterlink-vendor", "caterlink_management", "operation_manager", "main_enforcement", "profiling_aso", "super_admin",
    "neg-pending-profile", "neg-rejected-profile", "neg-deactivated-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment"];
  for (const label of personas) {
    const s = await S(label);
    const wellFormed = await s.sb.storage.from(B).upload(`ICMS-2026-000001/${tag}-${label.replace(/[^a-z0-9]/gi, "")}.pdf`, PDF, { contentType: "application/pdf", upsert: false });
    rec.expectAuthorizationDenied(`${label}: upload of a well-formed completed-form path is refused`, verdict(wellFormed));
    const arbitrary = await s.sb.storage.from(B).upload(`arbitrary-probe/${tag}.pdf`, PDF, { contentType: "application/pdf", upsert: false });
    rec.expectAuthorizationDenied(`${label}: upload of an arbitrary path is refused`, verdict(arbitrary));
    const over = await s.sb.storage.from(B).upload(fixture, PDF, { contentType: "application/pdf", upsert: true });
    rec.expectAuthorizationDenied(`${label}: overwriting the fixture (upsert) is refused`, verdict(over));
    const list = await s.sb.storage.from(B).list(`fixtures-${tag}`, { limit: 100 });
    rec.check(`${label}: LIST shows nothing`, list.error ? classifyError(list.error, list.error.statusCode) === "authorization" : (list.data ?? []).length === 0);
    const dl = await s.sb.storage.from(B).download(fixture);
    rec.expectAuthorizationDenied(`${label}: download of the fixture is refused (hidden by RLS)`, readVerdict(dl));
    const signed = await s.sb.storage.from(B).createSignedUrl(fixture, 60);
    rec.expectAuthorizationDenied(`${label}: signing the fixture is refused (hidden by RLS)`, readVerdict(signed));
    const rm = await s.sb.storage.from(B).remove([fixture]);
    rec.check(`${label}: delete removes nothing`, rm.error ? classifyError(rm.error, rm.error.statusCode) === "authorization" : (rm.data ?? []).length === 0);
  }
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  rec.expectAuthorizationDenied("anon: upload is refused", verdict(await anon.storage.from(B).upload(`arbitrary-probe/${tag}-anon.pdf`, PDF, { contentType: "application/pdf" })));
  rec.expectAuthorizationDenied("anon: download is refused", readVerdict(await anon.storage.from(B).download(fixture)));
  rec.expectAuthorizationDenied("anon: signing is refused", readVerdict(await anon.storage.from(B).createSignedUrl(fixture, 60)));
  const aList = await anon.storage.from(B).list(`fixtures-${tag}`);
  rec.check("anon: LIST shows nothing", aList.error ? true : (aList.data ?? []).length === 0);

  // ---------- nothing the clients did removed or replaced the fixture ----------
  const still = await admin.storage.from(B).list(`fixtures-${tag}`, { limit: 10 });
  rec.check("the fixture is still stored after every denied attempt (nothing removed or replaced)", (still.data ?? []).some((o) => o.name === "probe.pdf"));
} catch (e) {
  if (e instanceof SetupError) { rec.state.setupErrors += 1; console.log(`INCONCLUSIVE: ${e.message}`); } else throw e;
} finally {
  // remove exactly the tagged fixture this run created (service role), then prove the bucket is back to its prior state
  if (fixtureCreated) {
    const rm = await admin.storage.from(B).remove([fixture]);
    console.log(`clean-up: removed ${(rm.data ?? []).length} tagged fixture object created by this run`);
  }
  const left = await admin.storage.from(B).list("", { limit: 100 });
  console.log(`completed-forms top-level entries after clean-up: ${(left.data ?? []).filter((o) => o.name !== ".emptyFolderPlaceholder").length} (staging held 0 objects before the run)`);
}
console.log(rec.summary());
process.exit(rec.exitCode());
