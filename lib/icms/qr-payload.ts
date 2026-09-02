/**
 * CaterLink QR payload adapter.
 *
 * The real contract (confirmed against lib/icms/qr-token.ts and its callers
 * in lib/icms/actions/transactions.ts / vendor-transactions.ts): a QR pass
 * is the raw signed token string from generateQrToken() —
 * "<CATERING|VENDOR>.<transactionId>.<expiry>.<hmac>" (or a legacy 3-part
 * token, always CATERING) — printed/shown to the driver verbatim, with no
 * JSON envelope. scanTransaction() in lib/icms/actions/scan.ts verifies it
 * with verifyQrToken() before falling back to a bare id/transaction number
 * for manually typed references. This function still unwraps a simple JSON
 * envelope ({"transactionId"|"id"|"token": "..."}) as a defensive fallback
 * in case a QR is generated some other way, but the primary path scanning
 * an actual CaterLink-issued pass expects the raw token text.
 */
export function parseCaterLinkQrPayload(raw: string): { transactionId: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const candidate =
      (typeof parsed?.transactionId === "string" && parsed.transactionId) ||
      (typeof parsed?.id === "string" && parsed.id) ||
      (typeof parsed?.token === "string" && parsed.token) ||
      (typeof parsed?.t === "string" && parsed.t) ||
      null;
    if (candidate && candidate.trim()) {
      return { transactionId: candidate.trim() };
    }
  } catch {
    // Not JSON — fall through and treat the raw text as the reference itself.
  }

  return { transactionId: trimmed };
}
