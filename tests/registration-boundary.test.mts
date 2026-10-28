import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleRegistration, REGISTRATION_SUCCESS } from "../lib/auth/registration.ts";

type Calls = {
  createUser: unknown[];
  deleteUser: string[];
  profiles: unknown[];
  requests: unknown[];
  users: unknown[];
  lookups: string[];
  logs: string[];
  deleteProfiles: string[];
};

function fake(opts: {
  existing?: boolean;
  authError?: string | null;
  profileError?: string | null;
  requestError?: string | null;
  userError?: string | null;
  deleteFails?: boolean;
} = {}) {
  const calls: Calls = { createUser: [], deleteUser: [], profiles: [], requests: [], users: [], lookups: [], logs: [], deleteProfiles: [] };
  const admin = {
    from(table: string) {
      return {
        select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: async () => { calls.lookups.push(`${table}:${v}`); return { data: opts.existing ? { id: "x" } : null, error: null }; } }) }),
        upsert: async (row: unknown) => {
          (table === "profiles" ? calls.profiles : calls.users).push(row);
          const message = table === "profiles" ? opts.profileError : opts.userError;
          return { error: message ? { message } : null };
        },
        insert: async (row: unknown) => {
          if (table === "user_registration_requests") {
            calls.requests.push(row);
            return { error: opts.requestError ? { message: opts.requestError } : null };
          }
          return { error: null };
        },
        delete: () => ({
          eq: async (_col: string, val: string) => {
            if (table === "profiles") calls.deleteProfiles.push(val);
            return { error: null };
          },
        }),
      };
    },
    auth: {
      admin: {
        createUser: async (a: unknown) => { calls.createUser.push(a); return opts.authError ? { data: { user: null }, error: { message: opts.authError } } : { data: { user: { id: "u-1" } }, error: null }; },
        deleteUser: async (id: string) => { calls.deleteUser.push(id); if (opts.deleteFails) throw new Error("delete failed"); return { error: null }; },
      },
    },
  };
  return { admin, calls };
}

const baseBody = {
  system_type: "avsec", name: "Aisha Rahman", staff_id: "AK-1234", email: "Aisha@Example.com", phone: "+60 12-345 6789", password: "correct-horse-9",
  avsec_role: "ASO", team: "ALPHA", station: "KUL - MAA",
};
const caterBody = { system_type: "caterlink", name: "Lim Driver", staff_id: "DRV-77", email: "lim@example.com", phone: "0123456789", password: "correct-horse-9", driver_type: "driver_vendor", vendor_company: "Acme Catering", vehicle_plate: "wxx 1234" };

function req(body: unknown, headers: Record<string, string> = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, raw?: string) {
  return new Request("https://example.test/api/auth/register", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) });
}
function deps(f: ReturnType<typeof fake>, over: Partial<Parameters<typeof handleRegistration>[1]> = {}) {
  return {
    admin: f.admin as never,
    verify: async () => true,
    throttle: async () => "ok" as const,
    env: { antibotRequired: false, antibotConfigured: false },
    log: (e: string) => { f.calls.logs.push(e); },
    ...over,
  };
}
const json = async (r: Response) => r.json() as Promise<{ success?: string; error?: string }>;

test("a valid AVSEC request creates a pending, operational-role account only", async () => {
  const f = fake();
  const r = await handleRegistration(req(baseBody), deps(f));
  assert.equal(r.status, 200);
  assert.equal((await json(r)).success, REGISTRATION_SUCCESS);
  const created = f.calls.createUser[0] as { email: string; email_confirm: boolean; user_metadata: Record<string, unknown> };
  assert.equal(created.email, "aisha@example.com");
  assert.equal(created.email_confirm, true);
  assert.equal(f.calls.profiles.length, 1);
  const p = f.calls.profiles[0] as Record<string, unknown>;
  assert.equal(p.status, "pending");
  assert.equal(p.role, "ASO");
  assert.equal(p.station, "KUL - MAA");
  assert.equal(f.calls.requests.length, 1);
  const reqRow = f.calls.requests[0] as Record<string, unknown>;
  assert.equal(reqRow.profile_id, "u-1");
  assert.equal(reqRow.requested_role_code, "aso");
  assert.equal(reqRow.requested_operating_entity_id, null);
  assert.equal(reqRow.requested_aoc_id, null);
  assert.equal(reqRow.status, "pending");
});

test("a valid CaterLink request creates a pending vendor user", async () => {
  const f = fake();
  const r = await handleRegistration(req(caterBody), deps(f));
  assert.equal(r.status, 200);
  const u = f.calls.users[0] as Record<string, unknown>;
  assert.equal(u.status, "pending");
  assert.equal(u.role, "vendor");
  assert.equal(f.calls.profiles.length, 0);
  assert.equal(f.calls.requests.length, 0);
  assert.equal(((f.calls.createUser[0] as { user_metadata: Record<string, unknown> }).user_metadata).vehicle_plate, "WXX 1234");
});

test("an unknown system type is rejected, not treated as CaterLink", async () => {
  for (const system_type of ["admin", "CATERLINK", "", "avsec ", null, 7, {}]) {
    const f = fake();
    const r = await handleRegistration(req({ ...baseBody, system_type }), deps(f));
    assert.equal(r.status, 400, JSON.stringify(system_type));
    assert.equal(f.calls.createUser.length, 0);
  }
  // an absent system type keeps the documented default (avsec)
  const { system_type: _omit, ...noType } = baseBody;
  const f2 = fake();
  assert.equal((await handleRegistration(req(noType), deps(f2))).status, 200);
});

test("privileged roles, stations and teams cannot be self-selected", async () => {
  for (const patch of [{ avsec_role: "MANAGEMENT" }, { avsec_role: "ADMIN" }, { avsec_role: "ENFORCEMENT" }, { avsec_role: "operation_manager" }, { station: "HQ-SECRET" }, { team: "bad team!<script>" }, { role: "super_admin" }, { status: "approved" }]) {
    const f = fake();
    const r = await handleRegistration(req({ ...baseBody, ...patch }), deps(f));
    if ("role" in patch || "status" in patch) {
      // unknown extra fields are ignored; they never reach the account
      assert.equal(r.status, 200);
      const p = f.calls.profiles[0] as Record<string, unknown>;
      assert.equal(p.status, "pending");
      assert.equal(p.role, "ASO");
      assert.equal(JSON.stringify(f.calls.createUser[0]).includes("super_admin"), false);
    } else {
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.equal(f.calls.createUser.length, 0);
    }
  }
});

test("oversized and malformed fields are rejected before any account work", async () => {
  const cases: Record<string, unknown>[] = [
    { name: "x".repeat(101) }, { staff_id: "x".repeat(33) }, { email: `${"a".repeat(250)}@example.com` }, { phone: "1".repeat(33) }, { password: "x".repeat(129) },
    { password: "short" }, { email: "not-an-email" }, { name: "" }, { staff_id: "bad id <script>" }, { phone: "abc" }, { name: "Line\nBreak" },
  ];
  for (const patch of cases) {
    const f = fake();
    const r = await handleRegistration(req({ ...baseBody, ...patch }), deps(f));
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 60));
    assert.equal(f.calls.createUser.length, 0);
  }
  const f = fake();
  assert.equal((await handleRegistration(req({ ...caterBody, vendor_company: "v".repeat(101) }), deps(f))).status, 400);
  assert.equal((await handleRegistration(req({ ...caterBody, vehicle_plate: "p".repeat(21) }), deps(f))).status, 400);
  assert.equal((await handleRegistration(req({ ...caterBody, driver_type: "owner" }), deps(f))).status, 400);
  const big = await handleRegistration(req(null, undefined, JSON.stringify({ ...baseBody, junk: "j".repeat(20000) })), deps(fake()));
  assert.equal(big.status, 413);
  const bad = await handleRegistration(req(null, undefined, "{not json"), deps(fake()));
  assert.equal(bad.status, 400);
});

test("a failed anti-automation verification is refused before any lookup or account work", async () => {
  const f = fake();
  const r = await handleRegistration(req({ ...baseBody, verification_token: "bad" }), deps(f, { env: { antibotRequired: true, antibotConfigured: true }, verify: async () => false }));
  assert.equal(r.status, 400);
  assert.equal(f.calls.lookups.length, 0);
  assert.equal(f.calls.createUser.length, 0);
  const seen: unknown[] = [];
  const ok = await handleRegistration(req({ ...baseBody, verification_token: "good" }), deps(fake(), { env: { antibotRequired: true, antibotConfigured: true }, verify: async (t, ip) => { seen.push([t, ip]); return true; } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [["good", "203.0.113.9"]]);
  const missing = await handleRegistration(req(baseBody), deps(fake(), { env: { antibotRequired: true, antibotConfigured: true }, verify: async (t) => t === "good" }));
  assert.equal(missing.status, 400, "a missing token fails verification when it is required");
});

test("a validation error does not consume the anti-automation token, and the form resets the widget after any failure", async () => {
  let verifies = 0;
  const f = fake();
  const r = await handleRegistration(req({ ...baseBody, phone: "abc", verification_token: "t" }), deps(f, { env: { antibotRequired: true, antibotConfigured: true }, verify: async () => { verifies += 1; return true; } }));
  assert.equal(r.status, 400);
  assert.equal(verifies, 0, "the token is only verified for a request that is otherwise valid");
  const form = fs.readFileSync("app/register/register-form.tsx", "utf8");
  assert.match(form, /resetVerification|turnstile-reset|verificationResetKey/);
});

test("client address headers are trusted only behind a trusted proxy; otherwise one stricter shared bucket is used", async () => {
  const seen: string[] = [];
  const spoof = { "x-forwarded-for": "198.51.100.77", "x-real-ip": "198.51.100.78" };
  await handleRegistration(req(baseBody, spoof), deps(fake(), { env: { antibotRequired: true, antibotConfigured: true, trustProxyHeaders: false }, verify: async (_t, ip) => { seen.push(ip); return true; } }));
  assert.deepEqual(seen, ["unknown"]);
});

test("when verification is required but not configured the endpoint fails closed", async () => {
  const f = fake();
  const r = await handleRegistration(req(baseBody), deps(f, { env: { antibotRequired: true, antibotConfigured: false } }));
  assert.equal(r.status, 503);
  assert.deepEqual(await json(r), { error: "Registration is temporarily unavailable." });
  assert.equal(f.calls.lookups.length + f.calls.createUser.length, 0);
});

test("repeated requests are rate limited per address and per email, and a throttle fault fails closed", async () => {
  const keys: string[] = [];
  let n = 0;
  const throttle = async (key: string) => { keys.push(key); n += 1; return n > 2 ? ("limited" as const) : ("ok" as const); };
  const f = fake();
  const results: number[] = [];
  for (let i = 0; i < 3; i += 1) results.push((await handleRegistration(req(baseBody), deps(f, { throttle }))).status);
  assert.ok(results.includes(429), `a limited call returns 429 (${results})`);
  assert.equal(keys.every((k) => /^[0-9a-f]{64}$/.test(k)), true, "keys are hashes: no raw address or email is stored");
  assert.equal(keys.some((k) => k.includes("203.0.113.9") || k.includes("aisha")), false);
  const f2 = fake();
  const r = await handleRegistration(req(baseBody), deps(f2, { throttle: async () => "error" as const }));
  assert.equal(r.status, 503);
  assert.equal(f2.calls.createUser.length, 0);
});

test("a duplicate email gets the same response as a new one and creates nothing", async () => {
  const fresh = fake();
  const a = await handleRegistration(req(baseBody), deps(fresh));
  const dup = fake({ existing: true });
  const b = await handleRegistration(req(baseBody), deps(dup));
  assert.equal(b.status, a.status);
  assert.deepEqual(await json(b), await json(a));
  assert.equal(dup.calls.createUser.length, 0);
  // an Auth-level "already registered" is also indistinguishable
  const race = fake({ authError: "A user with this email address has already been registered" });
  const c = await handleRegistration(req(baseBody), deps(race));
  assert.equal(c.status, 200);
  assert.deepEqual(await json(c), { success: REGISTRATION_SUCCESS });
});

test("an Auth creation failure is generic: no upstream text, no account", async () => {
  const f = fake({ authError: 'duplicate key value violates unique constraint "users_pkey" at host db.supabase.co' });
  const r = await handleRegistration(req(baseBody), deps(f));
  assert.ok(r.status >= 500 || r.status === 503);
  const body = JSON.stringify(await json(r));
  assert.equal(/constraint|supabase|duplicate|users_pkey/i.test(body), false);
  assert.equal(f.calls.profiles.length, 0);
});

test("a profile or shadow-user failure rolls the Auth user back and exposes nothing", async () => {
  for (const [body, opt] of [[baseBody, { profileError: 'null value in column "x" of relation "profiles" violates not-null constraint' }], [caterBody, { userError: 'permission denied for table users' }]] as const) {
    const f = fake(opt);
    const r = await handleRegistration(req(body), deps(f));
    assert.equal(r.status, 500);
    assert.deepEqual(f.calls.deleteUser, ["u-1"], "the Auth user is deleted");
    const text = JSON.stringify(await json(r));
    assert.equal(/constraint|relation|permission|profiles|users/i.test(text), false);
  }
  const f = fake({ profileError: "boom", deleteFails: true });
  const r = await handleRegistration(req(baseBody), deps(f));
  assert.equal(r.status, 500, "a failed rollback still ends in a safe error");
});

test("a registration request failure rolls back the profile and Auth user cleanly", async () => {
  const f = fake({ requestError: 'null value in column "profile_id" violates not-null constraint' });
  const r = await handleRegistration(req(baseBody), deps(f));
  assert.equal(r.status, 500);
  assert.deepEqual(f.calls.deleteProfiles, ["u-1"], "the profile row is deleted");
  assert.deepEqual(f.calls.deleteUser, ["u-1"], "the Auth user is deleted");
  const text = JSON.stringify(await json(r));
  assert.equal(/constraint|relation|permission|profiles|users|user_registration_requests/i.test(text), false);
  assert.ok(f.calls.logs.includes("registration_request_failed"));
});

test("diagnostics are logged without personal data", async () => {
  const f = fake({ profileError: "boom aisha@example.com" });
  await handleRegistration(req(baseBody), deps(f));
  assert.ok(f.calls.logs.length > 0);
  assert.equal(f.calls.logs.join(" ").includes("aisha"), false);
});

test("the route is a thin wrapper and the form carries the verification token", () => {
  const route = fs.readFileSync("app/api/auth/register/route.ts", "utf8");
  assert.match(route, /handleRegistration/);
  assert.doesNotMatch(route, /authError\?\.message|profileError\.message|userError\.message|err\.message/);
  const form = fs.readFileSync("app/register/register-form.tsx", "utf8");
  assert.match(form, /<TurnstileField key=\{verificationResetKey\} \/>/);
  assert.match(fs.readFileSync("app/register/turnstile-field.tsx", "utf8"), /name="verification_token"/);
});

test("there is exactly one public registration path: no server action creates accounts or lets the caller choose a privileged role", () => {
  const legacy = fs.readFileSync("lib/icms/actions/registration.ts", "utf8");
  assert.doesNotMatch(legacy, /registerUser|auth\.signUp|RegisterState/, "the unused public registerUser server action (which accepted raw MANAGEMENT/ENFORCEMENT roles) is removed");
  for (const f of ["lib/icms/actions/registration.ts", "lib/icms/actions/auth.ts", "lib/avsec/profile-actions.ts"]) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /auth\.signUp\(|admin\.createUser\(/, `${f} does not create accounts`);
  }
});

test("timing: an existing email and a new email take the same time when the work fits inside the response floor", async () => {
  const run = async (existing: boolean, createMs: number) => {
    let clock = 0;
    const slept: number[] = [];
    const f = fake({ existing });
    const slowAdmin = {
      ...f.admin,
      auth: { admin: { ...f.admin.auth.admin, createUser: async (a: unknown) => { clock += createMs; return f.admin.auth.admin.createUser(a); } } },
      from: (t: string) => ({ ...f.admin.from(t), select: (c: string) => { clock += 10; return f.admin.from(t).select(c); } }),
    };
    const r = await handleRegistration(req(baseBody), deps(f, { admin: slowAdmin as never, now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; }, minResponseMs: 1000 } as never));
    return { status: r.status, total: clock, slept };
  };
  const existing = await run(true, 400);
  const fresh = await run(false, 400);
  assert.equal(existing.status, 200);
  assert.equal(fresh.status, 200);
  assert.equal(existing.total, 1000, "existing-email responses are padded up to the floor");
  assert.equal(fresh.total, 1000, "new-account responses end at the same floor");
  assert.ok(existing.slept.length > 0 && fresh.slept.length > 0);
});

test("timing: when the real work exceeds the floor no padding is added (the residual difference is documented, not hidden)", async () => {
  let clock = 0;
  const f = fake();
  const admin = { ...f.admin, auth: { admin: { ...f.admin.auth.admin, createUser: async (a: unknown) => { clock += 1500; return f.admin.auth.admin.createUser(a); } } } };
  const slept: number[] = [];
  await handleRegistration(req(baseBody), deps(f, { admin: admin as never, now: () => clock, sleep: async (ms: number) => { slept.push(ms); clock += ms; }, minResponseMs: 1000 } as never));
  assert.deepEqual(slept, []);
  const doc = fs.readFileSync("docs/dashboard-review/caterlink-workflow-gap-audit.md", "utf8");
  assert.match(doc, /enumeration resistance is therefore not complete/i, "the documentation must not claim complete enumeration resistance");
  assert.match(doc, /slower than the floor the timing still differs/i);
});

test("padding applies only to the account-exists / account-created outcomes, never to validation or rate-limit refusals", async () => {
  const slept: number[] = [];
  const common = { now: () => 0, sleep: async (ms: number) => { slept.push(ms); }, minResponseMs: 1000 } as never;
  await handleRegistration(req({ ...baseBody, phone: "abc" }), deps(fake(), common));
  await handleRegistration(req(baseBody), deps(fake(), { ...(common as object), throttle: async () => "limited" as const } as never));
  assert.deepEqual(slept, []);
});
