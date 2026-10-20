import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  THEME_STORAGE_KEY,
  THEME_LABELS,
  THEME_PREFERENCES,
  parsePreference,
  resolveTheme,
  themeInitScript,
  applyTheme,
  readStoredPreference,
  storePreference,
} from "../lib/theme/theme.ts";

type Listener = () => void;
function fakeEnv(opts: { stored?: Record<string, string>; systemDark?: boolean; storageThrows?: boolean }) {
  const store = new Map(Object.entries(opts.stored ?? {}));
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  const listeners: Listener[] = [];
  let systemDark = opts.systemDark ?? false;
  const documentElement = {
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), contains: (c: string) => classes.has(c) },
    style: { colorScheme: "" } as { colorScheme: string },
  };
  const localStorage = opts.storageThrows
    ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }
    : { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const matchMedia = (q: string) => ({ matches: q.includes("dark") ? systemDark : false, addEventListener: (_: string, l: Listener) => listeners.push(l), removeEventListener: () => {} });
  return { store, attrs, classes, documentElement, localStorage, matchMedia, setSystemDark: (v: boolean) => { systemDark = v; listeners.forEach((l) => l()); } };
}

test("the three preferences carry the approved labels", () => {
  assert.deepEqual([...THEME_PREFERENCES], ["light", "dark", "system"]);
  assert.equal(THEME_LABELS.light, "Light");
  assert.equal(THEME_LABELS.dark, "Dark");
  assert.equal(THEME_LABELS.system, "Use Device Setting");
});

test("parsePreference accepts only the three values and falls back to the device setting", () => {
  assert.equal(parsePreference("light"), "light");
  assert.equal(parsePreference("dark"), "dark");
  assert.equal(parsePreference("system"), "system");
  for (const bad of [null, undefined, "", "Dark", "auto", "solarized", 3, {}]) assert.equal(parsePreference(bad), "system");
});

test("resolveTheme: explicit choices win over the device; the device setting follows it", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("applyTheme sets data-theme, the dark class, the preference marker and color-scheme", () => {
  const env = fakeEnv({});
  applyTheme("dark", { root: env.documentElement as never, systemDark: false });
  assert.equal(env.attrs.get("data-theme"), "dark");
  assert.equal(env.attrs.get("data-theme-pref"), "dark");
  assert.ok(env.classes.has("dark"));
  assert.equal(env.documentElement.style.colorScheme, "dark");
  applyTheme("system", { root: env.documentElement as never, systemDark: false });
  assert.equal(env.attrs.get("data-theme"), "light");
  assert.equal(env.attrs.get("data-theme-pref"), "system");
  assert.ok(!env.classes.has("dark"));
  assert.equal(env.documentElement.style.colorScheme, "light");
});

test("storage: a stored choice is read, legacy keys still work, and a blocked storage never throws", () => {
  assert.equal(readStoredPreference({ getItem: () => "dark" } as never), "dark");
  assert.equal(readStoredPreference({ getItem: (k: string) => (k === "avsec-theme" ? "light" : null) } as never), "light");
  assert.equal(readStoredPreference({ getItem: () => { throw new Error("blocked"); } } as never), "system");
  assert.equal(readStoredPreference(null), "system");
  const written: Record<string, string> = {};
  storePreference("dark", { setItem: (k: string, v: string) => void (written[k] = v) } as never);
  assert.equal(written[THEME_STORAGE_KEY], "dark");
  assert.doesNotThrow(() => storePreference("dark", { setItem: () => { throw new Error("blocked"); } } as never));
});

function runInit(env: ReturnType<typeof fakeEnv>) {
  vm.runInNewContext(themeInitScript(), { document: { documentElement: env.documentElement }, localStorage: env.localStorage, window: { matchMedia: env.matchMedia } });
}

test("the pre-hydration script applies the right theme before first paint in every case", () => {
  const cases: Array<[string, Parameters<typeof fakeEnv>[0], "light" | "dark", string]> = [
    ["nothing stored, light device", { systemDark: false }, "light", "system"],
    ["nothing stored, dark device", { systemDark: true }, "dark", "system"],
    ["Light chosen on a dark device", { stored: { [THEME_STORAGE_KEY]: "light" }, systemDark: true }, "light", "light"],
    ["Dark chosen on a light device", { stored: { [THEME_STORAGE_KEY]: "dark" }, systemDark: false }, "dark", "dark"],
    ["Use Device Setting on a dark device", { stored: { [THEME_STORAGE_KEY]: "system" }, systemDark: true }, "dark", "system"],
    ["legacy key honoured", { stored: { "avsec-theme": "dark" }, systemDark: false }, "dark", "dark"],
    ["corrupt value falls back to the device", { stored: { [THEME_STORAGE_KEY]: "banana" }, systemDark: true }, "dark", "system"],
  ];
  for (const [name, opts, theme, pref] of cases) {
    const env = fakeEnv(opts);
    runInit(env);
    assert.equal(env.attrs.get("data-theme"), theme, name);
    assert.equal(env.attrs.get("data-theme-pref"), pref, name);
    assert.equal(env.classes.has("dark"), theme === "dark", name);
    assert.equal(env.documentElement.style.colorScheme, theme, name);
  }
});

test("the pre-hydration script never throws when storage or matchMedia is unavailable", () => {
  const env = fakeEnv({ storageThrows: true });
  assert.doesNotThrow(() => runInit(env));
  assert.equal(env.attrs.get("data-theme"), "light");
  assert.doesNotThrow(() => vm.runInNewContext(themeInitScript(), { document: { documentElement: env.documentElement }, localStorage: env.localStorage, window: {} }));
});

test("the theme preference is local only: no network, no Supabase, no cookie", () => {
  for (const f of ["lib/theme/theme.ts", "components/theme/ThemeProvider.tsx", "components/theme/AppearanceControl.tsx"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /supabase|fetch\(|document\.cookie|XMLHttpRequest|sendBeacon/i, f);
  }
});

test("the root layout applies the theme through the shared script, not a duplicate implementation", () => {
  const layout = fs.readFileSync("app/layout.tsx", "utf8");
  assert.match(layout, /themeInitScript/);
  assert.match(layout, /suppressHydrationWarning/);
  assert.doesNotMatch(layout, /localStorage\.getItem\("vecta-theme"\)/, "the inline copy of the old script is gone");
});
