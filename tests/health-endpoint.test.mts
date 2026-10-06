import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("app/api/health/route.ts", "utf8");

test("health endpoint uses the server-only admin client for its database probe", () => {
  assert.match(source, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin"/);
  assert.match(source, /const supabase = createAdminClient\(\)/);
  assert.doesNotMatch(source, /from "@\/lib\/supabase\/server"/);
});

test("health endpoint remains a bounded read-only database probe", () => {
  assert.match(source, /\.from\("profiles"\)/);
  assert.match(source, /\.select\("id"\)/);
  assert.match(source, /\.limit\(1\)/);
  assert.doesNotMatch(source, /\.(insert|update|upsert|delete)\s*\(/);
});
