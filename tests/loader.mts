// Minimal ESM resolution/load hook for running Phase 8 application-level
// tests directly against the real source files under plain `node
// --test`. Handles exactly three things this repo's Next.js-oriented
// source relies on that plain Node ESM doesn't support out of the box:
//   1. The "@/..." path alias (tsconfig "paths") -> project-root-relative.
//   2. Extension-less subpath imports from packages that ship .js files
//      but no package.json "exports" map forcing bundler-style
//      resolution (e.g. "next/cache" -> "next/cache.js").
//   3. .tsx/.jsx files (React client components) -- Node's own
//      --experimental-strip-types removes TypeScript type syntax only
//      and does not understand JSX at all, so any .tsx import fails
//      outright without this. A single `esbuild.transformSync` call
//      per file is the minimal way to make that work without pulling in
//      a full bundler/test-framework stack (Jest+Babel, Vite, etc.) --
//      esbuild is one small, fast, single-purpose dependency, used here
//      ONLY as a transform, never as a bundler or dev server.
// This is intentionally tiny and single-purpose -- not a general-purpose
// bundler shim -- consistent with "minimum viable test infrastructure".
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ROOT = pathToFileURL(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..") + "/").href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(ROOT + "tests/mocks/server-only-stub.mts", context);
  }
  if (specifier.startsWith("@/")) {
    const mapped = ROOT + specifier.slice(2);
    for (const ext of ["", ".ts", ".tsx"]) {
      try {
        return await nextResolve(mapped + ext, context);
      } catch (err) {
        if (!(err && err.code === "ERR_MODULE_NOT_FOUND")) throw err;
      }
    }
    return nextResolve(mapped, context); // surfaces the original error
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      for (const ext of [".ts", ".tsx", ".js"]) {
        try {
          return await nextResolve(specifier + ext, context);
        } catch {
          // try next extension
        }
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".tsx") || url.endsWith(".jsx")) {
    const filePath = fileURLToPath(url);
    const source = readFileSync(filePath, "utf8");
    const result = esbuild.transformSync(source, {
      loader: url.endsWith(".tsx") ? "tsx" : "jsx",
      format: "esm",
      target: "es2022",
      sourcefile: filePath,
      jsx: "automatic",
    });
    return { format: "module", shortCircuit: true, source: result.code };
  }
  return nextLoad(url, context);
}
