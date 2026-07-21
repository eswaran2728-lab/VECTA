import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed QR pass tokens. Format: <transactionId>.<expiryUnixSeconds>.<hmac>
 * The signature is HMAC-SHA256 over "<transactionId>.<expiry>" with a
 * server-side secret, so a QR pass cannot be forged or altered, and it
 * expires 24 hours after issue.
 */

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string {
  const s = process.env.QR_TOKEN_SECRET;
  if (!s || s.length < 32) {
    throw new Error("QR_TOKEN_SECRET is not configured");
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function generateQrToken(transactionId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${transactionId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export type QrTokenResult =
  | { ok: true; transactionId: string }
  | { ok: false; error: string };

export function verifyQrToken(token: string): QrTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: "Invalid QR pass. / Pas QR tidak sah.",
    };
  }
  const [tid, expRaw, sig] = parts;
  if (!UUID_RE.test(tid) || !/^\d+$/.test(expRaw)) {
    return { ok: false, error: "Invalid QR pass. / Pas QR tidak sah." };
  }

  const expected = sign(`${tid}.${expRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      error: "QR pass signature is invalid — possible forgery. / Tandatangan pas QR tidak sah.",
    };
  }

  if (parseInt(expRaw, 10) < Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      error:
        "QR pass has expired (24 hour limit). Ask the warehouse to reprint it from the transaction page. / Pas QR telah tamat tempoh (had 24 jam).",
    };
  }

  return { ok: true, transactionId: tid };
}
