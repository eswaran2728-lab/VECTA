/** Shared cookie names/lifetimes between app/api/auth/session/route.ts
 *  (sets them) and providers/firebase.ts (reads them). No secrets here —
 *  just names and durations, safe to import from either side. */
export const SESSION_COOKIE = "fb-session";
export const ID_TOKEN_COOKIE = "fb-id-token";
// Firebase ID tokens are valid for 1 hour; keep this cookie a little
// shorter so it never outlives the token it holds.
export const ID_TOKEN_MAX_AGE_S = 55 * 60;
// Firebase session cookies may be issued for up to 14 days.
export const SESSION_MAX_AGE_S = 14 * 24 * 60 * 60;
