// Pure helpers for the private staging credential files: a strong shared password and the text / HTML renderings. Nothing here reads or writes
// files or prints anything; the callers write outside the repository with restrictive permissions.
import crypto from "node:crypto";

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGIT = "23456789"; // no 0, 1
const SYMBOL = "-_.!@#";

const pick = (set) => set[crypto.randomInt(set.length)];

/** 28 characters, at least four of each class, shell/URL-safe, visually unambiguous. */
export function generateSharedPassword(length = 28) {
  const chars = [pick(LOWER), pick(LOWER), pick(LOWER), pick(LOWER), pick(UPPER), pick(UPPER), pick(UPPER), pick(UPPER), pick(DIGIT), pick(DIGIT), pick(DIGIT), pick(DIGIT), pick(SYMBOL), pick(SYMBOL)];
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

const NEGATIVE_TEXT = {
  pending: "signs in but is held on the pending-approval page: no functional access",
  rejected: "signs in but is restricted to the rejected-registration page: no functional access",
  deactivated: "signs in but is restricted (account deactivated): no functional access",
  revoked: "signs in but has no active assignment: no functional access (restricted)",
  expired: "signs in but the assignment has expired: no functional access (restricted)",
  future_dated: "signs in but the assignment starts in the future: no functional access (restricted)",
};

/** What a tester should expect when signing in as this account. */
export function accountExpectation(a) {
  if (a.kind === "negative") return `${a.expectedWorkspace ?? "restricted page"}; ${NEGATIVE_TEXT[a.accountState] ?? "no functional access (restricted)"}`;
  if (a.kind === "caterlink_external") return `${a.expectedWorkspace ?? "CaterLink portal"} only; no AVSEC pages`;
  return `lands on ${a.expectedWorkspace ?? "the role dashboard"}; only the pages and actions of this role and scope`;
}

const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

export function renderCredentialText({ url, password, accounts }) {
  const lines = ["VECTA STAGING", `URL: ${url}`, `PASSWORD FOR ALL POSITIVE TEST ACCOUNTS: ${password}`, "", "ROLE / ID / PASSWORD / EXPECTED"];
  for (const a of accounts) lines.push(`${clean(a.display ?? a.label)} / ${a.email} / ${password} / ${clean(accountExpectation(a))}`);
  return lines.join("\n") + "\n";
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderCredentialHtml({ url, password, accounts }) {
  const rows = accounts.map((a) => `<tr><td>${esc(a.display ?? a.label)}</td><td>${esc(a.email)}</td><td class="pw">${esc(password)}</td><td>${esc(a.scope)}</td><td>${esc(a.expectedWorkspace)}</td><td>${esc(a.accountState ?? a.kind)}</td><td>${esc(accountExpectation(a))}</td></tr>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>VECTA staging logins (confidential)</title>
<style>
 body{font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#111;margin:18px}
 h1{font-size:16px;margin:0 0 4px} .conf{color:#b00020;font-weight:bold;letter-spacing:.08em}
 .meta{margin:6px 0 10px;font-size:10px} .pw{font-family:Consolas,monospace}
 table{border-collapse:collapse;width:100%} th,td{border:1px solid #bbb;padding:3px 4px;vertical-align:top;text-align:left;word-break:break-word}
 th{background:#eee} tr:nth-child(even) td{background:#fafafa}
</style></head><body>
<div class="conf">CONFIDENTIAL - STAGING TEST ACCOUNTS - DO NOT SHARE OR COMMIT</div>
<h1>VECTA staging: all-role test logins</h1>
<div class="meta"><b>Preview URL:</b> ${esc(url)}<br><b>Shared password (all accounts):</b> <span class="pw">${esc(password)}</span><br>
Negative identities (pending, rejected, deactivated, revoked, expired, future-dated) sign in but must have no functional access.</div>
<table><thead><tr><th>Role / persona</th><th>Email</th><th>Password</th><th>Scope (AOC / entity / station / team)</th><th>Landing page</th><th>State</th><th>Access expectation</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
}
