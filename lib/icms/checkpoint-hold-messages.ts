/**
 * Instructions shown to the officer when a checkpoint is escalated AUTOMATICALLY by the database (a seal mismatch, a wrong seal colour
 * or an observed vehicle/driver that is not on the whitelist). The transaction is frozen at that moment, so the checkpoint form is gone
 * on the next render; the officer is therefore redirected to the transaction page, which shows the instruction from here.
 *
 * Keyed by the outcome code returned by record_caterlink_part_b_secure(). The page looks codes up in this table only (never echoes the
 * query string), so an arbitrary `?hold=` value renders nothing.
 */
export const PART_B_HOLD_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  SEAL_MISMATCH:
    "SEAL MISMATCH — the transaction has been escalated and the administrators notified. Do not release the vehicle. / KETIDAKPADANAN SIL — transaksi telah dieskalasi. Jangan lepaskan kenderaan.",
  WRONG_SEAL_COLOR:
    "WRONG SEAL COLOUR — the transaction has been escalated and the administrators notified. Do not release the vehicle. / WARNA SIL TIDAK BETUL — transaksi telah dieskalasi. Jangan lepaskan kenderaan.",
  WHITELIST_VIOLATION:
    "WHITELIST VIOLATION — the observed vehicle/driver is not on the active whitelist. The transaction has been escalated and the administrators notified. Do not release the vehicle. / PELANGGARAN SENARAI PUTIH — kenderaan/pemandu yang diperhatikan tiada dalam senarai putih aktif. Transaksi telah dieskalasi. Jangan lepaskan kenderaan.",
});

export function partBHoldMessage(code: string | undefined): string | null {
  return code && Object.prototype.hasOwnProperty.call(PART_B_HOLD_MESSAGES, code) ? PART_B_HOLD_MESSAGES[code] : null;
}
