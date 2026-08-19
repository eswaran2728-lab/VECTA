import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed QR pass tokens. Format: <type>.<transactionId>.<expiryUnixSeconds>.<hmac>
 * The signature is HMAC-SHA256 over "<type>.<transactionId>.<expiry>" with a
 * server-side secret, so a QR pass cannot be forged or altered, and it
 * expires 24 hours after issue. `type` distinguishes the catering IFCSF
 * flow from the Vendor Movement Module — both share this signer/verifier
 * but resolve against different tables downstream.
 *
 * Legacy 3-part tokens (<transactionId>.<expiry>.<hmac>, no type segment)
 * issued before the type segment existed are still accepted and always
 * treated as CATERING, so already-printed/cached QR passes keep working.
 */

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QrTokenType = "CATERING" | "VENDOR";

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

export function generateQrToken(transactionId: string, type: QrTokenType = "CATERING"): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${type}.${transactionId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export type QrTokenResult =
  | { ok: true; transactionId: string; type: QrTokenType }
  | { ok: false; error: string };

function checkExpiryAndReturn(
  transactionId: string,
  type: QrTokenType,
  expRaw: string
): QrTokenResult {
  if (parseInt(expRaw, 10) < Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      error:
        "QR pass has expired (24 hour limit). Ask the warehouse to reprint it from the transaction page. / Pas QR telah tamat tempoh (had 24 jam).",
    };
  }
  return { ok: true, transactionId, type };
}

export function verifyQrToken(token: string): QrTokenResult {
  const parts = token.split(".");

  if (parts.length === 4) {
    const [typeRaw, tid, expRaw, sig] = parts;
    if (
      (typeRaw !== "CATERING" && typeRaw !== "VENDOR") ||
      !UUID_RE.test(tid) ||
      !/^\d+$/.test(expRaw)
    ) {
      return { ok: false, error: "Invalid QR pass. / Pas QR tidak sah." };
    }

    const expected = sign(`${typeRaw}.${tid}.${expRaw}`);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return {
        ok: false,
        error: "QR pass signature is invalid — possible forgery. / Tandatangan pas QR tidak sah.",
      };
    }

    return checkExpiryAndReturn(tid, typeRaw as QrTokenType, expRaw);
  }

  if (parts.length === 3) {
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

    return checkExpiryAndReturn(tid, "CATERING", expRaw);
  }

  return {
    ok: false,
    error: "Invalid QR pass. / Pas QR tidak sah.",
  };
}
