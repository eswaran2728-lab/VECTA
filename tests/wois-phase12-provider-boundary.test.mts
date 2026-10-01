import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getWoisAiConfig } from "../lib/wois/config.ts";
import { getWoisProvider, _resetWoisProviderCacheForTests } from "../lib/wois/provider.ts";

const ENV_KEYS = [
  "WOIS_AI_PROVIDER",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "WOIS_AI_TIMEOUT_MS",
  "WOIS_AI_MAX_OUTPUT_TOKENS",
  "WOIS_AI_MAX_TOOL_CALLS",
  "WOIS_AI_MAX_HISTORY_MESSAGES",
] as const;

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void) {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- Configuration selection (no network, no SDK construction) ----------

test("Phase 12 config: Gemini is selected only when BOTH WOIS_AI_PROVIDER=gemini AND GEMINI_API_KEY are set", () => {
  withEnv({ WOIS_AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real" }, () => {
    assert.equal(getWoisAiConfig().provider, "gemini");
  });
});

test("Phase 12 config: missing GEMINI_API_KEY falls back to rule_engine even if WOIS_AI_PROVIDER=gemini", () => {
  withEnv({ WOIS_AI_PROVIDER: "gemini", GEMINI_API_KEY: undefined }, () => {
    assert.equal(getWoisAiConfig().provider, "rule_engine");
  });
});

test("Phase 12 config: any non-'gemini' WOIS_AI_PROVIDER value falls back to rule_engine, even with a key present", () => {
  withEnv({ WOIS_AI_PROVIDER: "openai", GEMINI_API_KEY: "test-key-not-real" }, () => {
    assert.equal(getWoisAiConfig().provider, "rule_engine");
  });
  withEnv({ WOIS_AI_PROVIDER: undefined, GEMINI_API_KEY: "test-key-not-real" }, () => {
    assert.equal(getWoisAiConfig().provider, "rule_engine");
  });
});

test("Phase 12 config: numeric overrides are bounded, never trusted verbatim from the environment", () => {
  withEnv(
    {
      WOIS_AI_TIMEOUT_MS: "999999999",
      WOIS_AI_MAX_OUTPUT_TOKENS: "999999999",
      WOIS_AI_MAX_TOOL_CALLS: "999999999",
      WOIS_AI_MAX_HISTORY_MESSAGES: "999999999",
    },
    () => {
      const config = getWoisAiConfig();
      assert.ok(config.timeoutMs <= 30000);
      assert.ok(config.maxOutputTokens <= 4096);
      assert.ok(config.maxToolCalls <= 5);
      assert.ok(config.maxHistoryMessages <= 50);
    }
  );
});

test("Phase 12 config: a garbage numeric override falls back to the documented default instead of NaN", () => {
  withEnv({ WOIS_AI_TIMEOUT_MS: "not-a-number" }, () => {
    const config = getWoisAiConfig();
    assert.equal(config.timeoutMs, 8000);
  });
});

// --- getWoisProvider() selection, WITHOUT ever configuring Gemini --------
// (Only the "unconfigured" branch is exercised here -- this never imports
// or constructs the real @google/genai client, so no SDK code and no
// network call happens from this test file at all.)

test("Phase 12 provider selection: with no Gemini configuration, getWoisProvider() returns the deterministic rule engine", async () => {
  _resetWoisProviderCacheForTests();
  await withEnvAsync({ WOIS_AI_PROVIDER: undefined, GEMINI_API_KEY: undefined }, async () => {
    const provider = await getWoisProvider();
    assert.equal(provider.name, "rule_engine");
  });
  _resetWoisProviderCacheForTests();
});

async function withEnvAsync(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<void>) {
  const saved: Partial<Record<string, string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// --- Client-bundle boundary: static source scan --------------------------
// A full `npm run build` + grep of .next/static is the authoritative check
// (run manually as part of this phase's verification sequence, documented
// in the final report) -- it is too slow to run as a unit test on every
// invocation. This test is the fast, always-on guard: no "use client"
// component may import the Gemini key/provider/config modules at all, so
// there is no source-level path for the key to reach a client bundle in
// the first place.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function listFilesRecursive(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

test("Phase 12 client-bundle boundary: no 'use client' component imports the Gemini provider, config, or SDK", () => {
  const candidateDirs = ["app", "components"].map((d) => path.join(REPO_ROOT, d));
  const offenders: string[] = [];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of listFilesRecursive(dir, [".tsx", ".ts"])) {
      const content = fs.readFileSync(file, "utf8");
      const isClientComponent = content.includes('"use client"') || content.includes("'use client'");
      if (!isClientComponent) continue;
      if (content.includes("lib/wois/provider") || content.includes("lib/wois/config") || content.includes("@google/genai")) {
        offenders.push(file);
      }
    }
  }

  assert.deepEqual(offenders, [], `Client components must never import the Gemini provider/config/SDK: ${offenders.join(", ")}`);
});

test("Phase 12 client-bundle boundary: GEMINI_API_KEY is never referenced with a NEXT_PUBLIC_ prefix anywhere in source", () => {
  const candidateDirs = ["app", "components", "lib"].map((d) => path.join(REPO_ROOT, d));
  const offenders: string[] = [];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of listFilesRecursive(dir, [".tsx", ".ts"])) {
      const content = fs.readFileSync(file, "utf8");
      if (/NEXT_PUBLIC_[A-Z_]*GEMINI/i.test(content)) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
