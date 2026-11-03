/** A saved draft with the time it was saved (ISO). An empty time means it was never recorded. */
export interface TimedDraft<T = unknown> {
  data: T;
  savedAt: string;
}

export type DraftResume =
  | { kind: "none" }
  | { kind: "local" }
  | { kind: "server" }
  | { kind: "conflict"; localSavedAt: string; serverSavedAt: string; newer: "local" | "server" | "unknown" };

/**
 * Decides which draft a form resumes. Pure so the rule is tested: one side only resumes without asking; identical content is not a conflict; different
 * content on both devices is a conflict the user must resolve. Nothing is ever overwritten silently, and a draft with no recorded time never claims to be newer.
 */
export function decideDraftResume(local: TimedDraft | null, server: TimedDraft | null): DraftResume {
  if (!local && !server) return { kind: "none" };
  if (local && !server) return { kind: "local" };
  if (!local && server) return { kind: "server" };
  if (JSON.stringify(local!.data) === JSON.stringify(server!.data)) return { kind: "local" };
  const l = Date.parse(local!.savedAt);
  const s = Date.parse(server!.savedAt);
  const newer = Number.isFinite(l) && Number.isFinite(s) ? (l >= s ? "local" : "server") : "unknown";
  return { kind: "conflict", localSavedAt: local!.savedAt, serverSavedAt: server!.savedAt, newer };
}

/** Local and server drafts are removed only when the server has CONFIRMED the submission; a queued, failed or recovering submission keeps them. */
export function shouldClearDraftsAfter(outcome: "submitted" | "queued" | "failed" | "recovery"): boolean {
  return outcome === "submitted";
}
