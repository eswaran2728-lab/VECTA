import fs from "node:fs";
import path from "node:path";
import type { WoisEligibility } from "@/lib/avsec/types";

/**
 * Private WOIS source documents. The PDF is the internal knowledge source: it is served only to the callers WOIS chat and history serve
 * (is_wois_eligible_secure(): approved profile + active Malaysia-AOC assignment), only from this fixed allowlist, and only from a
 * directory that is NOT a public static path. The request supplies an id that must match an allowlist entry exactly; it is never part
 * of a file path.
 */
export interface WoisDocument {
  /** File name inside the private directory (never taken from a request). */
  file: string;
  /** Download name sent to the browser. */
  filename: string;
}

export const WOIS_DOCUMENTS: Readonly<Record<string, WoisDocument>> = Object.freeze({
  W_O_I_S: { file: "W_O_I_S.pdf", filename: "W_O_I_S.pdf" },
});

export const WOIS_PRIVATE_DIR = path.join(process.cwd(), "private", "wois");

const NO_STORE = "private, no-store, max-age=0";
const json = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": NO_STORE, "X-Content-Type-Options": "nosniff" } });

/** Exact allowlist lookup by key or by "<key>.pdf"; anything else (separators, dots, case variants, empty) is unknown. */
function lookup(id: string, documents: Readonly<Record<string, WoisDocument>>): WoisDocument | null {
  for (const [key, doc] of Object.entries(documents)) {
    if (id === key || id === doc.file) return doc;
  }
  return null;
}

/** Resolves an allowlisted id to a file inside `root`; null when unknown or when the resolved file would leave the directory. */
export function resolveWoisDocument(
  id: string,
  root: string,
  documents: Readonly<Record<string, WoisDocument>> = WOIS_DOCUMENTS,
): { path: string; filename: string } | null {
  const doc = lookup(id, documents);
  if (!doc) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, doc.file);
  if (!target.startsWith(base + path.sep)) return null;
  try {
    // defence in depth: a symlink or junction must not lead out of the directory
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    if (!realTarget.startsWith(realBase + path.sep)) return null;
  } catch {
    return null;
  }
  return { path: target, filename: doc.filename };
}

export interface WoisDocumentDeps {
  eligibility: () => Promise<WoisEligibility>;
  root: string;
  read?: (file: string) => Promise<Buffer>;
}

export async function handleWoisDocument(id: string, deps: WoisDocumentDeps): Promise<Response> {
  let elig: WoisEligibility;
  try {
    elig = await deps.eligibility();
  } catch {
    return json(503, "Not available.");
  }
  if (!elig.eligible) {
    if (elig.reason === "unauthenticated") return json(401, "Unauthorized");
    if (elig.reason === "not_eligible") return json(403, "Not available.");
    return json(503, "Not available.");
  }

  const doc = resolveWoisDocument(id, deps.root);
  if (!doc) return json(404, "Document not found.");

  try {
    const bytes = await (deps.read ?? ((f: string) => fs.promises.readFile(f)))(doc.path);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${doc.filename}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": NO_STORE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return json(500, "Document unavailable.");
  }
}
