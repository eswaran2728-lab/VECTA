/**
 * CaterLink QR payload adapter — PLACEHOLDER.
 *
 * CaterLink (the app that will eventually own vendor/warehouse movement,
 * replacing the retired warehouse_pic/receiver/vendor roles here) is being
 * built independently, and its QR payload format is not yet defined. This
 * function is the single, isolated seam for that format: everything
 * downstream (the ops_group scope check, the transaction lookup, the
 * clearance workflow) only ever calls this function and works off its
 * return value — when CaterLink's real spec ships, only this function
 * should need editing.
 *
 * Current placeholder behavior: treats the raw scanned string as a
 * transaction id/number directly, optionally unwrapping a simple JSON
 * envelope like {"transactionId": "..."} / {"id": "..."} / {"token": "..."}
 * if the raw text happens to be JSON.
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
