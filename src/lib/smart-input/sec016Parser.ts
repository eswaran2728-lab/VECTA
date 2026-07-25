// Heuristic "Smart Input" parser for SEC 016 (ASO Attending Flight Report).
// Extracts field values from a pasted WhatsApp-style aircraft handling message.
// Regex/keyword based, tolerant of different officers' phrasing (label synonyms,
// WhatsApp bold markers, "HRS" time suffixes, etc.) — never guesses: a field is only
// set when a recognizable label is matched, everything else is left for manual entry.

export interface Sec016ParsedFields {
  duty_date?: string;
  flight?: string;
  origin_arr_dep?: string;
  reg_no?: string;
  bay_no?: string;
  sta_std?: string;
  ata_atd?: string;
  reason_for_delay?: string;
  staff_frisked?: "YES" | "NO";
  ramp_staff_1?: string;
  ramp_staff_2?: string;
  ramp_staff_3?: string;
  ramp_staff_4?: string;
  ramp_staff_5?: string;
}

// The fixed set of fields Smart Input is capable of detecting — used to report
// "filled X of Y" regardless of how many of them a given message actually mentions.
export const SEC016_PARSEABLE_FIELDS: (keyof Sec016ParsedFields)[] = [
  "duty_date",
  "flight",
  "origin_arr_dep",
  "reg_no",
  "bay_no",
  "sta_std",
  "ata_atd",
  "reason_for_delay",
  "staff_frisked",
  "ramp_staff_1",
  "ramp_staff_2",
  "ramp_staff_3",
  "ramp_staff_4",
  "ramp_staff_5",
];

const MONTHS: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

function stripMarkup(text: string): string {
  // Strip WhatsApp formatting markers (*bold*, _italic_, ~strike~, `code`) — noise, not data.
  return text.replace(/[*_~`]/g, "");
}

/** Matches the first line starting with one of the given label patterns and returns
 * whatever follows the ":" / "-" separator on that line, trimmed. Null if none match. */
function matchLine(clean: string, labelPatterns: string[]): string | null {
  for (const label of labelPatterns) {
    const re = new RegExp(`^[ \\t]*${label}[ \\t]*[:\\-][ \\t]*(.+?)[ \\t]*$`, "im");
    const m = clean.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function parseDate(raw: string): string | null {
  const named = raw.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (named) {
    const day = named[1]!;
    const month = MONTHS[named[2]!.toLowerCase()];
    const year = named[3]!;
    if (month) return `${year}-${month}-${day.padStart(2, "0")}`;
  }
  const numeric = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (numeric) {
    const day = numeric[1]!;
    const month = numeric[2]!;
    const yearRaw = numeric[3]!;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return null;
}

function parseTime(raw: string): string | null {
  const colon = raw.match(/(\d{1,2}):(\d{2})/);
  if (colon) return `${colon[1]!.padStart(2, "0")}:${colon[2]}`;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return null;
}

export function parseSec016WhatsAppMessage(rawText: string): Sec016ParsedFields {
  const clean = stripMarkup(rawText);
  const result: Sec016ParsedFields = {};

  const dateRaw = matchLine(clean, ["date"]);
  if (dateRaw) {
    const parsed = parseDate(dateRaw);
    if (parsed) result.duty_date = parsed;
  }

  const flight = matchLine(clean, ["flight\\s*no\\.?", "flight\\s*number", "flight", "flt\\s*no\\.?"]);
  if (flight) result.flight = flight.toUpperCase().replace(/\s+/g, "");

  const sector = matchLine(clean, ["sector", "route", "sector\\s*\\/\\s*route", "origin\\s*[\\/-]?\\s*dest"]);
  if (sector) result.origin_arr_dep = sector.toUpperCase().replace(/\s+/g, "");

  const regNo = matchLine(clean, ["reg\\.?\\s*no\\.?", "registration", "a\\/c\\s*reg\\.?", "aircraft\\s*reg\\.?"]);
  if (regNo) result.reg_no = regNo.toUpperCase().replace(/\s+/g, "");

  const bay = matchLine(clean, ["bay\\s*\\/\\s*gate", "bay", "gate", "parking\\s*bay"]);
  if (bay) result.bay_no = bay.toUpperCase().replace(/\s+/g, "");

  // Form field is labeled "STA / STD" — a single slot covering either, depending on
  // whether the officer is reporting an arrival or a departure.
  const std = matchLine(clean, ["std", "sta"]);
  if (std) {
    const t = parseTime(std);
    if (t) result.sta_std = t;
  }

  const atd = matchLine(clean, ["atd", "ata"]);
  if (atd) {
    const t = parseTime(atd);
    if (t) result.ata_atd = t;
  }

  const delayReason = matchLine(clean, ["delay\\s*reason", "reason\\s*for\\s*delay"]);
  if (delayReason) result.reason_for_delay = delayReason;

  // "BODY FRISKING✅" / "Body Frisking: NO" / "Frisking - Yes" — checkmark or explicit
  // yes/no on the line mentioning "frisk".
  const friskLine = clean.split("\n").find((l) => /frisk/i.test(l));
  if (friskLine) {
    if (/[✅✓]|\byes\b/i.test(friskLine)) result.staff_frisked = "YES";
    else if (/[❌✗]|\bno\b/i.test(friskLine)) result.staff_frisked = "NO";
  }

  // RAMP STAFF block: consecutive non-empty lines following a "RAMP STAFF" heading,
  // stopping at the next blank line or recognized section header.
  const lines = clean.split("\n").map((l) => l.trim());
  const rampIdx = lines.findIndex((l) => /^ramp\s*staff/i.test(l));
  if (rampIdx !== -1) {
    const names: string[] = [];
    for (let i = rampIdx + 1; i < lines.length && names.length < 5; i++) {
      const line = lines[i];
      if (!line) break;
      if (/^(body\s*frisk|frisk|cargo|shift\s*leader)/i.test(line)) break;
      names.push(line);
    }
    names.forEach((name, idx) => {
      const key = `ramp_staff_${idx + 1}` as keyof Sec016ParsedFields;
      (result[key] as string) = name;
    });
  }

  return result;
}
