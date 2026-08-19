import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** All timestamps are stored UTC and displayed in Asia/Kuala_Lumpur. */
const TZ = "Asia/Kuala_Lumpur";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: TZ,
  });
}

/** Minutes between two timestamps, or null when either is missing. */
export function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/** Parse QR payload: accepts {"transactionId":"uuid"}, a bare uuid, or a /transactions/<uuid> URL. */
export function parseQrPayload(raw: string): string | null {
  const uuidRe =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.transactionId === "string" && uuidRe.test(parsed.transactionId)) {
      return parsed.transactionId;
    }
  } catch {
    // not JSON - fall through
  }
  const match = raw.match(uuidRe);
  return match ? match[0] : null;
}
