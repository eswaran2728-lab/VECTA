// Pure decision logic for the future-assignment fixture refresh (unit-tested; no I/O, no secrets).
export const FUTURE_LABEL = "neg-future-assignment";
export const FUTURE_OFFSET_DAYS = 3650;
/** An assignment already this far ahead is left alone (idempotent). */
export const ALREADY_FAR_DAYS = 365;
export const AUTHORIZATION_PHRASE = "REFRESH-FUTURE-ASSIGNMENT-FIXTURE";
const DAY = 86_400_000;

/** Picks the ONE manifest account that may be touched: the future-assignment negative fixture, by label or by its recorded state. */
export function selectFixtureAccount(accounts) {
  const matches = (accounts ?? []).filter((a) => a.label === FUTURE_LABEL || a.accountState === "future_dated");
  if (matches.length !== 1) throw new Error(`Expected exactly one future-assignment fixture in the manifest, found ${matches.length}.`);
  return matches[0];
}

/**
 * assignments: the active (not revoked) assignment rows of that one profile, each { id, role_code, starts_at, ends_at }.
 * Returns { action: "noop" | "update", reason, id?, newStartsAt? }. Throws when the shape is not exactly the fixture's.
 */
export function planFixtureRefresh(assignments, now = new Date()) {
  const live = (assignments ?? []).filter((a) => !a.revoked_at);
  if (live.length !== 1) throw new Error(`The fixture profile must hold exactly one non-revoked assignment (found ${live.length}); refusing.`);
  const a = live[0];
  if (a.ends_at) throw new Error("The fixture assignment has an end date; refusing to guess.");
  const start = new Date(a.starts_at).getTime();
  if (Number.isNaN(start)) throw new Error("The fixture assignment has no valid start date.");
  const farEnough = +now + ALREADY_FAR_DAYS * DAY;
  if (start >= farEnough) return { action: "noop", reason: `already starts at least ${ALREADY_FAR_DAYS} days ahead`, id: a.id };
  return { action: "update", reason: start <= +now ? "the start date has passed: the account is active, not future-dated" : "the start date is too close", id: a.id, newStartsAt: new Date(+now + FUTURE_OFFSET_DAYS * DAY).toISOString() };
}

/** Live execution needs the flag AND the exact phrase AND the environment confirmation. Anything else is a dry run. */
export function resolveMode({ apply, authorization, envConfirmation }) {
  if (!apply) return "dry-run";
  if (authorization !== AUTHORIZATION_PHRASE) throw new Error("Live execution needs --authorization=" + AUTHORIZATION_PHRASE + " (a separate, explicit authorization).");
  if (envConfirmation !== "yes") throw new Error("Live execution also needs VECTA_FIXTURE_REFRESH_AUTHORIZED=yes in the environment.");
  return "live";
}
