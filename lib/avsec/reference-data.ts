// Shared reference data. Backed by DB tables (stations, teams, aircraft_types) so Admin
// can update without code changes; these arrays are the seed / offline fallback values.

export const STATIONS = [
  "KUL - MAA",
  "KUL - AAX",
  "AOR",
  "BKI",
  "BTU",
  "JHB",
  "KBR",
  "KCH",
  "LBU",
  "LGK",
  "MYY",
  "PEN",
  "SBW",
  "SDK",
  "TGG",
  "TWU",
  "KUA",
  "IPH",
  "MKZ",
  "SZB",
] as const;

export type Station = (typeof STATIONS)[number];

// SEC029-only station list: "KUL - MAA" / "KUL - AAX" collapsed into a single "KUL" —
// specific to this report's Station field, per its Rev.03 spec. Every other report
// still uses the shared STATIONS list above unchanged.
export const SEC029_STATIONS: readonly string[] = [
  "KUL",
  ...STATIONS.filter((s) => s !== "KUL - MAA" && s !== "KUL - AAX"),
];

// Team names are free text, entered by hand — different stations use different team
// names, so this is no longer a fixed list. Kept only as placeholder/example values.
export const TEAM_EXAMPLES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"] as const;

export const AIRCRAFT_TYPES = ["A320", "A321", "A330"] as const;
export type AircraftType = (typeof AIRCRAFT_TYPES)[number];

export const USER_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "SUPER_ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number] | "ADMIN";

// Roles a new signup can request for themselves — Management/Enforcement or operational roles.
export const REQUESTABLE_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT"] as const;

// Org-wide roles aren't tied to a specific team, so they don't need a staff ID/team on
// their profile and they monitor every team's reports (not just their own).
export const ORG_WIDE_ROLES = ["ENFORCEMENT", "MANAGEMENT"] as const;

// Mirrors the role_rank() SQL function — keep in sync. ASO < SO < DSE < ENFORCEMENT < MANAGEMENT.
export const ROLE_RANK: Record<string, number> = {
  ASO: 1,
  SO: 2,
  DSE: 3,
  ENFORCEMENT: 4,
  MANAGEMENT: 5,
  ADMIN: 5,
  SUPER_ADMIN: 6,
};

export const ROLE_LABELS: Record<string, string> = {
  ASO: "ASO — Assistant Security Officer",
  SO: "SO — Security Officer",
  DSE: "DSE",
  ENFORCEMENT: "Enforcement",
  MANAGEMENT: "Management Team",
  ADMIN: "Management Team",
  SUPER_ADMIN: "Platform Super Admin",
};

// Functional grouping (supabase/migrations/team_based_ops_groups.sql) — a
// separate axis from `team` (ALPHA/BRAVO/CHARLIE/DELTA shift rotation).
// Scopes Reports/Scan visibility. Required for SO/ASO/DSE; org-wide roles
// (ADMIN/MANAGEMENT/ENFORCEMENT) never have one.
export const OPS_GROUPS = ["operation_avsec", "ifc_avsec", "hub_avsec"] as const;
export type OpsGroup = (typeof OPS_GROUPS)[number];

export const OPS_GROUP_LABELS: Record<OpsGroup, string> = {
  operation_avsec: "Operation AVSEC",
  ifc_avsec: "IFC AVSEC",
  hub_avsec: "Hub AVSEC",
};

// Roles that require an ops_group (everyone who isn't org-wide).
export const OPS_GROUP_REQUIRED_ROLES = ["ASO", "SO", "DSE"] as const;

export const PROFILE_STATUSES = ["pending", "approved", "rejected", "deactivated"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const REPORT_TYPES = ["sec016", "sec014", "sec029", "sec018", "sec033", "sec013"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

// SEC 013 Section 2 "Duty Area" — fixed/pre-filled value (no longer user-selectable;
// AA/SEC/F/013 Rev.03 profiling duty is always Departure Gate).
export const SEC013_DUTY_AREA_VALUE = "Departure Gate" as const;

export const SEC013_CERTIFICATION_TEXT =
  "I certify that the information provided in this report is true, complete and accurate to the best of my knowledge.";

// Table names are typed loosely here (not against the generated Database
// type) so this file doesn't need to import the Supabase schema just to
// describe report metadata — callers that pass REPORT_META[type].table into
// supabase.from() cast it to the literal table-name union at the call site.
export const REPORT_META: Record<
  ReportType | "offload",
  { name: string; code: string; table: string; route: string }
> = {
  sec016: {
    name: "ASO ATTENDING FLIGHT REPORT SEC 016",
    code: "AA/SEC/F/016 Rev.03",
    table: "report_sec016",
    route: "sec016",
  },
  sec014: {
    name: "ASO DAILY REPORT SEC 014",
    code: "AA/SEC/F/014 Rev.03",
    table: "report_sec014",
    route: "sec014",
  },
  sec029: {
    name: "AIRCRAFT SEARCH CHECKLIST SEC 029",
    code: "AA/SEC/F/029 Rev.03",
    table: "report_sec029",
    route: "sec029",
  },
  sec018: {
    name: "Aircraft Security Patrol and Guarding Duty Log SEC 018",
    code: "AA/SEC/F/018 Rev.01",
    table: "report_sec018",
    route: "sec018",
  },
  sec033: {
    name: "AIRCRAFT HOLD CHECKLIST SEC 033",
    code: "AA/SEC/F/033 Rev.02",
    table: "report_sec033",
    route: "sec033",
  },
  sec013: {
    name: "DAILY REPORT PROFILING SEC 013",
    code: "AA/SEC/F/013 Rev.03",
    table: "report_sec013",
    route: "sec013",
  },
  offload: {
    name: "OFFLOAD INFORMATION (DEPARTURE FLIGHT)",
    code: "AVSEC-OFL Digital",
    table: "offload_records",
    route: "offload",
  },
};

// Shown on SEC033/SEC013-style reports carrying sensitive security information.
export const SECURITY_DISCLAIMER =
  "This report contains sensitive security information intended solely for authorized AirAsia Security (AVSEC). Any unauthorized access, disclosure, duplication or distribution is strictly prohibited.";

// SEC 029 checklist item catalogue — order matches the physical form.
// Rev.03: removed the standalone (A) I. VISUAL INSPECTION and (B) IV. VISUAL
// INSPECTION items (their headings are now heading-only, no independent controls);
// renamed C(III) LIFE JACKET -> LIFE JACKET POUCHES; "A. AIRCRAFT (EXTERNAL)" ->
// "A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)"; "B. CARGO HOLD (EXTERNAL)" -> "CARGO
// HOLD (EXTERNAL)". See SEC029_LEGACY_ITEM_LABELS below for the removed items' labels
// — historical reports that recorded them still display correctly.
// Cargo Hold (External) update: B_EXT_V relabeled "(B) V. FLOOR & WALL CEILING" ->
// "(B) V. DOOR, FLOOR & WALL CEILING" (same code, no data impact); added B_EXT_VII
// "(C) Inspect any cavities, compartments inside the hold" — reports submitted before
// this change simply have no B_EXT_VII row, which the existing report.items-driven
// rendering already handles (nothing fabricated, the item just doesn't appear).
export const SEC029_ITEMS: {
  code: string;
  section: string;
  label: string;
  allowNotApplicable?: boolean;
}[] = [
  { code: "A_I", section: "A. GALLEY", label: "A(I) ALL STOWAGE COMPARTMENT" },
  { code: "A_II", section: "A. GALLEY", label: "A(II) WASTE BIN" },
  { code: "B_I", section: "B. LAVATORY", label: "B(I) ALL STOWAGE COMPARTMENT" },
  { code: "B_II", section: "B. LAVATORY", label: "B(II) WASTE BIN" },
  { code: "B_III", section: "B. LAVATORY", label: "B(III) DRAWER" },
  { code: "B_IV", section: "B. LAVATORY", label: "B(IV) TOILET BOWLS" },
  { code: "C_I", section: "C. SEAT", label: "C(I) ARM REST" },
  { code: "C_II", section: "C. SEAT", label: "C(II) SEAT POCKETS" },
  { code: "C_III", section: "C. SEAT", label: "C(III) LIFE JACKET POUCHES" },
  { code: "A1", section: "OTHER ACCESSIBLE COMPARTMENTS", label: "A1. OVERHEAD COMPARTMENTS" },
  { code: "B1", section: "OTHER ACCESSIBLE COMPARTMENTS", label: "B1. CREW SEATS & SEAT COMPARTMENTS" },
  { code: "A2", section: "COCKPIT AREA", label: "A2. SEATS" },
  { code: "B2", section: "COCKPIT AREA", label: "B2. FLOOR AREA" },
  { code: "C2", section: "COCKPIT AREA", label: "C2. COMPARTMENTS" },
  {
    code: "US_SEALS",
    section: "4. U.S FLIGHTS ONLY",
    label: "LAVATORY SHROUDS SECURITY SEALS",
    allowNotApplicable: true,
  },
  { code: "A_EXT_II", section: "A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)", label: "I. LANDING GEAR BAY" },
  { code: "A_EXT_III", section: "A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)", label: "(A) III. WHEELS AND BODIES" },
  { code: "B_EXT_V", section: "CARGO HOLD (EXTERNAL)", label: "(B) V. DOOR, FLOOR & WALL CEILING" },
  { code: "B_EXT_VI", section: "CARGO HOLD (EXTERNAL)", label: "(B) VI. RESTRAINT NETS" },
  { code: "B_EXT_VII", section: "CARGO HOLD (EXTERNAL)", label: "(C) Inspect any cavities, compartments inside the hold" },
];

// Removed items' labels, kept only so a historical report that recorded them (before
// Rev.03) still renders correctly in the detail view / PDF instead of showing a bare
// item code.
export const SEC029_LEGACY_ITEM_LABELS: Record<string, string> = {
  A_EXT_I: "(A) I. VISUAL INSPECTION",
  B_EXT_IV: "(B) IV. VISUAL INSPECTION",
};

export function sec029ItemLabel(code: string): string {
  return SEC029_ITEMS.find((i) => i.code === code)?.label ?? SEC029_LEGACY_ITEM_LABELS[code] ?? code;
}

// SEC016_CHECKED_OPTIONS ("CHECKED?" — COCKPIT/CABIN/F/AID KITS/HOLDS/NOT APPLICABLE)
// removed in AA/SEC/F/016 Rev.03 — historical reports still carry checked_items in the
// database and render it if present, but nothing new writes to it.
