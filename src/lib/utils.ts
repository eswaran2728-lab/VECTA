import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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
