import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isEffectiveSuperAdminAssignment, type SuperAdminAssignmentFacts } from "../lib/super-admin/assignment-rules.ts";
import { resolveEffectiveRole, isSuperAdminPathForbidden, isOperationalPathForbiddenForSuperAdmin } from "../lib/supabase/middleware-gate-logic.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const NOW = new Date("2026-10-05T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const active: SuperAdminAssignmentFacts = {
  roleCode: "super_admin", roleIsActive: true, profileStatus: "approved", revokedAt: null, startsAt: day(-1), endsAt: null,
};

// ---------- pure rule: every denial state + the allowed path ----------
test("canonical rule: active super_admin assignment is allowed (open-ended and future-ending)", () => {
  assert.equal(isEffectiveSuperAdminAssignment(active, NOW), true);
  assert.equal(isEffectiveSuperAdminAssignment({ ...active, endsAt: day(5) }, NOW), true);
});

const denials: Array<[string, Partial<SuperAdminAssignmentFacts>]> = [
  ["revoked", { revokedAt: day(-1) }],
  ["expired", { startsAt: day(-3), endsAt: day(-1) }],
  ["expiring exactly now", { endsAt: NOW.toISOString() }],
  ["future-dated", { startsAt: day(1) }],
  ["inactive role definition", { roleIsActive: false }],
  ["pending profile", { profileStatus: "pending" }],
  ["rejected profile", { profileStatus: "rejected" }],
  ["deactivated profile", { profileStatus: "deactivated" }],
  ["missing profile", { profileStatus: undefined }],
  ["a different role code", { roleCode: "operation_manager" }],
  ["legacy-style SUPER_ADMIN code", { roleCode: "SUPER_ADMIN" }],
  ["missing start date", { startsAt: null }],
];
for (const [label, patch] of denials) {
  test(`canonical rule: ${label} is denied`, () => {
    assert.equal(isEffectiveSuperAdminAssignment({ ...active, ...patch }, NOW), false);
  });
}

// ---------- edge decision ----------
test("edge decision: a legacy 'super_admin' value never confers Super Admin; only the canonical result does", () => {
  assert.equal(resolveEffectiveRole("super_admin", false), null);
  assert.equal(resolveEffectiveRole(null, false), null);
  assert.equal(resolveEffectiveRole("admin", false), "admin");
  assert.equal(resolveEffectiveRole("management", false), "management");
  assert.equal(resolveEffectiveRole("admin", true), "super_admin");
  assert.equal(resolveEffectiveRole(null, true), "super_admin");
});

test("edge decision: legacy ADMIN / MANAGEMENT / anonymous are forbidden from /super-admin; canonical Super Admin is allowed and kept off operational routes", () => {
  for (const legacy of ["admin", "management", "enforcement", "so", null, "super_admin"]) {
    assert.equal(isSuperAdminPathForbidden("/super-admin", resolveEffectiveRole(legacy, false)), true, `legacy ${legacy}`);
  }
  assert.equal(isSuperAdminPathForbidden("/super-admin", resolveEffectiveRole(null, true)), false);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/dashboard", resolveEffectiveRole(null, true)), true);
});

// ---------- caller-side helper (mocked Supabase boundary) ----------
let authUser: { id: string } | null = null;
let rpcResult: { data: unknown; error: unknown } = { data: true, error: null };
const calls: string[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: authUser } }) },
      rpc: async (name: string, args: unknown) => {
        calls.push(`rpc:${name}:${JSON.stringify(args)}`);
        return rpcResult;
      },
      from: (table: string) => {
        calls.push(`from:${table}`);
        throw new Error("legacy table read is forbidden for Super Admin authority");
      },
    }),
  },
});

type Row = { profile_id: string; revoked_at: string | null; starts_at: string | null; ends_at: string | null; role_definitions: { code: string; is_active: boolean } };
let assignmentRows: Row[] = [];
let profileRows: Array<{ id: string; status: string }> = [];
mock.module("@/lib/supabase/admin", {
  namedExports: {
    createAdminClient: () => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.in = () => (table === "profiles" ? Promise.resolve({ data: profileRows, error: null }) : chain);
        chain.eq = () => Promise.resolve({ data: assignmentRows, error: null });
        return chain;
      },
    }),
  },
});

const authority = await import("../lib/super-admin/authority.ts");
const actions = await import("../lib/super-admin/actions.ts");

test("caller helper: anonymous caller is denied without any query", async () => {
  authUser = null; calls.length = 0;
  assert.equal(await authority.hasActiveSuperAdminRole(), false);
  assert.equal(await actions.isSuperAdmin(), false);
  assert.deepEqual(calls, []);
});

test("caller helper: active canonical super_admin is allowed via has_active_role only (no legacy table read)", async () => {
  authUser = { id: "u1" }; rpcResult = { data: true, error: null }; calls.length = 0;
  assert.equal(await actions.isSuperAdmin(), true);
  assert.deepEqual(calls, ['rpc:has_active_role:{"p_role_code":"super_admin"}']);
});

test("caller helper: database denial, RPC error and non-boolean results are all denied", async () => {
  authUser = { id: "u1" };
  for (const r of [{ data: false, error: null }, { data: null, error: { message: "boom" } }, { data: "true", error: null }, { data: null, error: null }]) {
    rpcResult = r;
    assert.equal(await actions.isSuperAdmin(), false);
  }
});

test("target protection: only an effective super_admin assignment on an approved profile is protected", async () => {
  const mk = (id: string, patch: Partial<Row> & { code?: string; active?: boolean } = {}): Row => ({
    profile_id: id, revoked_at: patch.revoked_at ?? null, starts_at: patch.starts_at === undefined ? day(-1) : patch.starts_at, ends_at: patch.ends_at ?? null,
    role_definitions: { code: patch.code ?? "super_admin", is_active: patch.active ?? true },
  });
  assignmentRows = [
    mk("active"), mk("revoked", { revoked_at: day(-1) }), mk("expired", { starts_at: day(-3), ends_at: day(-1) }),
    mk("future", { starts_at: day(1) }), mk("inactive", { active: false }), mk("pending"), mk("rejected"),
  ];
  profileRows = [
    { id: "active", status: "approved" }, { id: "revoked", status: "approved" }, { id: "expired", status: "approved" },
    { id: "future", status: "approved" }, { id: "inactive", status: "approved" }, { id: "pending", status: "pending" }, { id: "rejected", status: "rejected" },
  ];
  const ids = [...assignmentRows.map((r) => r.profile_id), "legacy-admin-no-assignment"];
  const protectedIds = await authority.getActiveSuperAdminProfileIds(ids);
  assert.deepEqual([...protectedIds], ["active"]);
  assert.equal(await authority.isProfileActiveSuperAdmin("legacy-admin-no-assignment"), false);
  assert.equal((await authority.getActiveSuperAdminProfileIds([])).size, 0);
});

// ---------- closure: no real Super Admin gate reads legacy columns ----------
const MIGRATED = [
  "lib/super-admin/actions.ts", "lib/super-admin/authority.ts", "lib/super-admin/assignment-rules.ts",
  "app/super-admin/page.tsx", "app/super-admin/readiness/page.tsx", "lib/avsec/admin/actions.ts",
  "lib/avsec/announcements/queries.ts", "components/layout/AppSidebar.tsx", "components/avsec/admin/UsersTable.tsx",
];

test("closure: migrated Super Admin gate files contain no legacy SUPER_ADMIN / super_admin-by-column check", () => {
  for (const f of MIGRATED) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/["']SUPER_ADMIN["']/.test(code), `${f} must not compare against legacy SUPER_ADMIN`);
    assert.ok(!/unified_role\s*(===|==|!==)\s*["']super_admin["']/.test(code), `${f} must not gate on unified_role`);
    assert.ok(!/["']super_admin["']\s*\]?\.includes|includes\([^)]*["']super_admin["']/.test(code), `${f} must not list super_admin in a legacy role array`);
  }
});

test("closure: middleware decides roles only from canonical assignments (never a legacy column, email or metadata)", () => {
  const mw = read("lib/supabase/middleware.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/["']SUPER_ADMIN["']/.test(mw), "middleware must not reference legacy SUPER_ADMIN");
  assert.ok(!/unified_role|uRole|profile\?\.role/.test(mw), "middleware must not derive roles from legacy columns");
  assert.ok(!/userEmail|user_metadata|userMeta/.test(mw), "middleware must not authorize or route from email text or user-editable metadata");
  assert.equal((mw.match(/rpc\("get_my_active_role_assignments"\)/g) ?? []).length, 2, "login redirect and the general gate each use the canonical assignments RPC");
  assert.equal((mw.match(/rpc\("has_active_role", \{ p_role_code: "super_admin" \}\)/g) ?? []).length, 1, "readiness gate uses has_active_role");
  assert.match(mw, /effectiveGateRole\(access, icmsRole\)/);
});

test("closure: AVSEC requireProfile and user-management guards use the canonical authority", () => {
  assert.match(read("lib/avsec/auth.ts"), /access\.isSuperAdmin\) redirect\("\/super-admin"\)/);
  const actionsSrc = read("lib/avsec/admin/actions.ts");
  assert.equal((actionsSrc.match(/await isProfileActiveSuperAdmin\(profileId\)/g) ?? []).length, 3, "deactivate, delete and reassign each protect a canonical Super Admin target");
  assert.ok(!/select\("role, unified_role"\)/.test(actionsSrc));
});

test("closure: the Super Admin portal links to the readiness route and every action goes through isSuperAdmin()", () => {
  assert.match(read("app/super-admin/page.tsx"), /href="\/super-admin\/readiness"/);
  const src = read("lib/super-admin/actions.ts");
  assert.equal((src.match(/await isSuperAdmin\(\)/g) ?? []).length, 3);
});

// `unified_role` no longer exists on the staging baseline and must not decide or
// be written by any production code. Only the generated database type files
// (which mirror whatever schema they were generated from) may name it.
const GENERATED_TYPE_FILES = new Set(["lib/icms/database.types.ts", "lib/supabase/database.types.ts"]);

test("closure: no handwritten production code references unified_role (reads, writes or props)", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && /unified_role|unifiedRole/.test(read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))) found.push(rel);
    }
  };
  for (const d of ["app", "lib", "components"]) walk(d);
  const unexpected = found.filter((f) => !GENERATED_TYPE_FILES.has(f));
  assert.deepEqual(unexpected, [], `unreviewed unified_role reference(s): ${unexpected.join(", ")}`);
});
