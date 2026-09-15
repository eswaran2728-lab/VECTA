// Heuristic "Smart Input" parser for SEC 016 (ASO Attending Flight Report).
// Extracts field values from a pasted WhatsApp-style aircraft handling message.
// Regex/keyword based, tolerant of different officers' phrasing (label synonyms,
// WhatsApp bold markers, "HRS" time suffixes, etc.) — never guesses: a field is only
// set when a recognizable label is matched, everything else is left for manual entry.
//
// Covers the full SEC016 form (see components/avsec/forms/Sec016Form.tsx /
// lib/avsec/schemas/sec016.ts) so the standardised WhatsApp template shared with
// staff can fill in every field, not just a subset.

export interface Sec016ParsedFields {
  flight_type?: "arrival" | "departure";
  duty_date?: string;
  duty_hour?: string;
  flight?: string;
  origin_arr_dep?: string;
  assisted_by?: string;
  aircraft_type?: "A 320" | "A 321" | "A 330" | "Other";
  aircraft_type_other?: string;
  reg_no?: string;
  bay_no?: string;
  sta_std?: string;
  ata_atd?: string;
  reason_for_delay?: string;
  do_infmd?: "YES" | "NO";
  inbound_baggage?: string;
  outbound_baggage?: string;
  inbound_cargo?: string;
  outbound_cargo?: string;
  inbound_co_mail?: string;
  outbound_co_mail?: string;
  shift_leader?: string;
  staff_frisked?: "YES" | "NO";
  cargo_hold_checked?: "YES" | "NO";
  cabin_check?: "YES" | "NO";
  discrepancies?: string;
  offload_baggage_tag_no?: string;
  offload_remark?: string;
  /** Names found under a "RAMP AGENTS (BAGGAGE)" / "RAMP STAFF" heading go here, one
   *  per line. */
  ramp_agents_baggage?: string;
  /** Names found under a "RAMP AGENTS (CARGO)" heading go here, one per line. */
  ramp_agents_cargo?: string;
}

// The fixed set of fields Smart Input is capable of detecting — used to report
// "filled X of Y" regardless of how many of them a given message actually mentions.
export const SEC016_PARSEABLE_FIELDS: (keyof Sec016ParsedFields)[] = [
  "flight_type",
  "duty_date",
  "duty_hour",
  "flight",
  "origin_arr_dep",
  "assisted_by",
  "aircraft_type",
  "aircraft_type_other",
  "reg_no",
  "bay_no",
  "sta_std",
  "ata_atd",
  "reason_for_delay",
  "do_infmd",
  "inbound_baggage",
  "outbound_baggage",
  "inbound_cargo",
  "outbound_cargo",
  "inbound_co_mail",
  "outbound_co_mail",
  "shift_leader",
  "staff_frisked",
  "cargo_hold_checked",
  "cabin_check",
  "discrepancies",
  "offload_baggage_tag_no",
  "offload_remark",
  "ramp_agents_baggage",
  "ramp_agents_cargo",
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

/** Collects consecutive non-empty lines following a heading line (no ":" value on
 * the heading itself), stopping at the next blank line or recognized section header. */
function matchBlock(clean: string, headingPatterns: string[], stopPatterns: string[]): string | null {
  const lines = clean.split("\n").map((l) => l.trim());
  for (const heading of headingPatterns) {
    const idx = lines.findIndex((l) => new RegExp(`^${heading}[ \\t]*:?[ \\t]*$`, "i").test(l));
    if (idx === -1) continue;
    const collected: string[] = [];
    for (let i = idx + 1; i < lines.length && collected.length < 10; i++) {
      const line = lines[i];
      if (!line) break;
      if (stopPatterns.some((p) => new RegExp(`^${p}`, "i").test(line))) break;
      collected.push(line);
    }
    if (collected.length > 0) return collected.join("\n");
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

/** "YES"/"NO", tolerant of a leading checkmark/cross instead of the word. */
function parseYesNo(raw: string): "YES" | "NO" | null {
  if (/^[✅✓]/.test(raw) || /^yes\b/i.test(raw)) return "YES";
  if (/^[❌✗]/.test(raw) || /^no\b/i.test(raw)) return "NO";
  return null;
}

export function parseSec016WhatsAppMessage(rawText: string): Sec016ParsedFields {
  const clean = stripMarkup(rawText);
  const result: Sec016ParsedFields = {};

  // Flight direction — from an "ARRIVAL"/"DEPARTURE" heading (e.g. "SEC016 - ARRIVAL")
  // or an explicit "Direction:" line. Checked first since baggage/cargo/co-mail below
  // read the direction-specific labels directly regardless of this.
  if (/\barrival\b/i.test(clean.split("\n").slice(0, 3).join("\n"))) result.flight_type = "arrival";
  else if (/\bdeparture\b/i.test(clean.split("\n").slice(0, 3).join("\n"))) result.flight_type = "departure";

  const dateRaw = matchLine(clean, ["date"]);
  if (dateRaw) {
    const parsed = parseDate(dateRaw);
    if (parsed) result.duty_date = parsed;
  }

  const dutyHour = matchLine(clean, ["duty\\s*hour", "duty\\s*time"]);
  if (dutyHour) {
    const t = parseTime(dutyHour);
    if (t) result.duty_hour = t;
  }

  const flight = matchLine(clean, ["flight\\s*no\\.?", "flight\\s*number", "flight", "flt\\s*no\\.?"]);
  if (flight) result.flight = flight.toUpperCase().replace(/\s+/g, "");

  const sector = matchLine(clean, [
    "origin", "destination", "sector", "route", "sector\\s*\\/\\s*route", "origin\\s*[\\/-]?\\s*dest",
  ]);
  if (sector) result.origin_arr_dep = sector.toUpperCase().replace(/\s+/g, "");

  const assistedBy = matchLine(clean, ["assisted\\s*by"]);
  if (assistedBy) result.assisted_by = assistedBy;

  const aircraftTypeRaw = matchLine(clean, ["aircraft\\s*type", "a\\/c\\s*type"]);
  if (aircraftTypeRaw) {
    const normalized = aircraftTypeRaw.toUpperCase().replace(/\s+/g, "");
    if (["A320", "A321", "A330"].includes(normalized)) {
      result.aircraft_type = `A ${normalized.slice(1)}` as "A 320" | "A 321" | "A 330";
    } else {
      result.aircraft_type = "Other";
      result.aircraft_type_other = aircraftTypeRaw;
    }
  }

  const regNo = matchLine(clean, ["reg\\.?\\s*no\\.?", "registration", "a\\/c\\s*reg\\.?", "aircraft\\s*reg\\.?"]);
  if (regNo) result.reg_no = regNo.toUpperCase().replace(/\s+/g, "");

  const bay = matchLine(clean, ["bay\\s*\\/\\s*gate", "bay\\s*no\\.?", "bay", "gate", "parking\\s*bay"]);
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

  const doInfmd = matchLine(clean, ["d\\s*\\/?\\s*o\\s*infmd", "do\\s*infmd"]);
  if (doInfmd) {
    const yn = parseYesNo(doInfmd);
    if (yn) result.do_infmd = yn;
  }

  const inboundBaggage = matchLine(clean, ["inbound\\s*baggage"]);
  if (inboundBaggage) result.inbound_baggage = inboundBaggage;
  const outboundBaggage = matchLine(clean, ["outbound\\s*baggage"]);
  if (outboundBaggage) result.outbound_baggage = outboundBaggage;

  const inboundCargo = matchLine(clean, ["inbound\\s*cargo"]);
  if (inboundCargo) result.inbound_cargo = inboundCargo;
  const outboundCargo = matchLine(clean, ["outbound\\s*cargo"]);
  if (outboundCargo) result.outbound_cargo = outboundCargo;

  const inboundCoMail = matchLine(clean, ["inbound\\s*co[\\s-]?mail(?:\\s*\\/\\s*comat)?"]);
  if (inboundCoMail) result.inbound_co_mail = inboundCoMail;
  const outboundCoMail = matchLine(clean, ["outbound\\s*co[\\s-]?mail(?:\\s*\\/\\s*comat)?"]);
  if (outboundCoMail) result.outbound_co_mail = outboundCoMail;

  const shiftLeader = matchLine(clean, [
    "ramp\\s*loading\\s*supervisor(?:\\s*\\(?rls\\)?)?", "rls", "shift\\s*leader",
  ]);
  if (shiftLeader) result.shift_leader = shiftLeader;

  const cargoHoldChecked = matchLine(clean, ["cargo\\s*hold\\s*checked"]);
  if (cargoHoldChecked) {
    const yn = parseYesNo(cargoHoldChecked);
    if (yn) result.cargo_hold_checked = yn;
  }

  // "BODY FRISKING✅" / "Staff Frisked: NO" / "Frisking - Yes" — checkmark or explicit
  // yes/no on the line mentioning "frisk".
  const friskLine = clean.split("\n").find((l) => /frisk/i.test(l));
  if (friskLine) {
    const afterColon = friskLine.split(/[:\-]/).slice(1).join(":").trim() || friskLine;
    const yn = parseYesNo(afterColon) ?? (/[✅✓]/.test(friskLine) ? "YES" : /[❌✗]/.test(friskLine) ? "NO" : null);
    if (yn) result.staff_frisked = yn;
  }

  const cabinCheck = matchLine(clean, ["cabin\\s*check"]);
  if (cabinCheck) {
    const yn = parseYesNo(cabinCheck);
    if (yn) result.cabin_check = yn;
  }

  const discrepancies = matchLine(clean, ["discrepanc(?:y|ies)"]);
  if (discrepancies) result.discrepancies = discrepancies;

  const offloadRemark = matchLine(clean, ["offload\\s*remark"]);
  if (offloadRemark) result.offload_remark = offloadRemark;

  const offloadTags = matchBlock(
    clean,
    ["offload\\s*baggage\\s*tag\\s*no\\.?"],
    ["offload\\s*remark", "ramp\\s*agents", "ramp\\s*staff", "cargo\\s*hold", "staff\\s*frisked", "discrepanc"],
  );
  if (offloadTags) result.offload_baggage_tag_no = offloadTags;
  else {
    // Single-line form: "Offload Baggage Tag No: TAG123, TAG124"
    const single = matchLine(clean, ["offload\\s*baggage\\s*tag\\s*no\\.?"]);
    if (single) result.offload_baggage_tag_no = single;
  }

  // RAMP AGENTS (BAGGAGE) / RAMP STAFF block: consecutive non-empty lines following
  // the heading, stopping at the next blank line or recognized section header.
  const rampStop = [
    "ramp\\s*agents", "ramp\\s*staff", "body\\s*frisk", "frisk", "cargo\\s*hold", "cabin\\s*check",
    "discrepanc", "offload",
  ];
  const rampBaggage = matchBlock(
    clean,
    ["ramp\\s*agents\\s*\\(?baggage\\)?", "ramp\\s*staff\\s*\\(?baggage\\)?", "ramp\\s*staff"],
    rampStop,
  );
  if (rampBaggage) result.ramp_agents_baggage = rampBaggage;

  const rampCargo = matchBlock(clean, ["ramp\\s*agents\\s*\\(?cargo\\)?", "ramp\\s*staff\\s*\\(?cargo\\)?"], rampStop);
  if (rampCargo) result.ramp_agents_cargo = rampCargo;

  return result;
}
