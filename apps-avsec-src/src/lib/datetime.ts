import { formatInTimeZone } from "date-fns-tz";

export const APP_TIMEZONE = "Asia/Kuala_Lumpur";

export function formatDateTimeMY(iso: string | null | undefined, pattern = "dd MMM yyyy, HH:mm") {
  if (!iso) return "—";
  try {
    return formatInTimeZone(new Date(iso), APP_TIMEZONE, pattern);
  } catch {
    return "—";
  }
}

export function formatDateMY(iso: string | null | undefined) {
  return formatDateTimeMY(iso, "dd MMM yyyy");
}

export function formatTimeMY(iso: string | null | undefined) {
  return formatDateTimeMY(iso, "HH:mm");
}

export function todayISODateMY(): string {
  return formatInTimeZone(new Date(), APP_TIMEZONE, "yyyy-MM-dd");
}

export function nowTimeMY(): string {
  return formatInTimeZone(new Date(), APP_TIMEZONE, "HH:mm");
}

/** Hours elapsed between an ISO timestamp and now. */
export function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

/** Combines a YYYY-MM-DD date and HH:MM time (assumed Asia/Kuala_Lumpur, UTC+8) into an ISO timestamp. */
export function combineDateTimeMY(date: string, time: string): string {
  if (!date || !time) return "";
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

/** Splits an ISO timestamp back into MY-local {date, time} for editing. */
export function splitDateTimeMY(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  return {
    date: formatDateTimeMY(iso, "yyyy-MM-dd"),
    time: formatDateTimeMY(iso, "HH:mm"),
  };
}

/** ISO {from, to} bounds for a single MY-local calendar day (UTC+8). */
export function dayRangeMY(date: string): { from: string; to: string } {
  return { from: `${date}T00:00:00+08:00`, to: `${date}T23:59:59.999+08:00` };
}
