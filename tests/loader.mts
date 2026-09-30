// Minimal ESM resolution hook for running Phase 8 application-level tests
// directly against the real source files under plain `node --test`.
// Handles exactly two things this repo's Next.js-oriented source relies
// on that plain Node ESM resolution doesn't support out of the box:
//   1. The "@/..." path alias (tsconfig "paths") -> project-root-relative.
//   2. Extension-less subpath imports from packages that ship .js files
//      but no package.json "exports" map forcing bundler-style
//      resolution (e.g. "next/cache" -> "next/cache.js").
// This is intentionally tiny and single-purpose -- not a general-purpose
// bundler shim -- consistent with "minimum viable test infrastructure".
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = pathToFileURL(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..") + "/").href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(ROOT + "tests/mocks/server-only-stub.mts", context);
  }
  if (specifier.startsWith("@/")) {
    const mapped = ROOT + specifier.slice(2);
    try {
      return await nextResolve(mapped, context);
    } catch (err) {
      if (err && err.code === "ERR_MODULE_NOT_FOUND") {
        return nextResolve(mapped + ".ts", context);
      }
      throw err;
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      for (const ext of [".ts", ".js"]) {
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
