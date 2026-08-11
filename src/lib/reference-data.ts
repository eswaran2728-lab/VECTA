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

// Team names are free text, entered by hand — different stations use different team
// names, so this is no longer a fixed list. Kept only as placeholder/example values.
export const TEAM_EXAMPLES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"] as const;

export const AIRCRAFT_TYPES = ["A320", "A321", "A330"] as const;
export type AircraftType = (typeof AIRCRAFT_TYPES)[number];

export const USER_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Roles a new signup can request for themselves — ADMIN is never self-selectable,
// it can only be granted by an existing admin.
export const REQUESTABLE_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT"] as const;

// Org-wide roles aren't tied to a specific team, so they don't need a staff ID/team on
// their profile and they monitor every team's reports (not just their own).
export const ORG_WIDE_ROLES = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"] as const;

// Mirrors the role_rank() SQL function — keep in sync. ASO < SO < DSE < ENFORCEMENT <
// MANAGEMENT < ADMIN. Each role monitors reports from any strictly lower rank.
export const ROLE_RANK: Record<UserRole, number> = {
  ASO: 1,
  SO: 2,
  DSE: 3,
  ENFORCEMENT: 4,
  MANAGEMENT: 5,
  ADMIN: 6,
};

export const ROLE_LABELS: Record<UserRole, string> = {
  ASO: "ASO — Assistant Security Officer",
  SO: "SO — Security Officer",
  DSE: "DSE",
  ENFORCEMENT: "Enforcement",
  MANAGEMENT: "Management Team",
  ADMIN: "Admin",
};

export const PROFILE_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const REPORT_TYPES = ["sec016", "sec014", "sec029", "sec018", "sec033", "sec013"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

// SEC 013 Section 2 "Duty Area" options.
export const SEC013_DUTY_AREAS = ["Departure Gate", "Terminal Area", "Apron"] as const;

// SEC 013 Section 2 "Location" options.
export const SEC013_LOCATIONS = [
  "Departure Gate Sector 5/6/7 (P-Q)",
  "Departure Gate Sector 1 & 3 (J & L/K)",
  "Terminal Area (Sector 2)",
] as const;

export const SEC013_CERTIFICATION_TEXT =
  "I certify that the information provided in this report is true, complete and accurate to the best of my knowledge.";

export const REPORT_META: Record<
  ReportType,
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
    name: "PATROLLING OF AIRCRAFT AT PARKING BAY SEC 018",
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
};

// Shown on SEC033/SEC013-style reports carrying sensitive security information.
export const SECURITY_DISCLAIMER =
  "This report contains sensitive security information intended solely for authorized AirAsia Security (AVSEC). Any unauthorized access, disclosure, duplication or distribution is strictly prohibited.";

// SEC 029 checklist item catalogue — order matches the physical form.
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
  { code: "C_III", section: "C. SEAT", label: "C(III) LIFE JACKET" },
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
  { code: "A_EXT_I", section: "A. AIRCRAFT (EXTERNAL)", label: "(A) I. VISUAL INSPECTION" },
  { code: "A_EXT_II", section: "A. AIRCRAFT (EXTERNAL)", label: "(A) II. LANDING GEAR BAYS" },
  { code: "A_EXT_III", section: "A. AIRCRAFT (EXTERNAL)", label: "(A) III. WHEELS AND BODIES" },
  { code: "B_EXT_IV", section: "B. CARGO HOLD (EXTERNAL)", label: "(B) IV. VISUAL INSPECTION" },
  { code: "B_EXT_V", section: "B. CARGO HOLD (EXTERNAL)", label: "(B) V. FLOOR & WALL CEILING" },
  { code: "B_EXT_VI", section: "B. CARGO HOLD (EXTERNAL)", label: "(B) VI. RESTRAINT NETS" },
];

export const SEC016_CHECKED_OPTIONS = [
  "COCKPIT",
  "CABIN",
  "F/AID KITS",
  "HOLDS",
  "NOT APPLICABLE",
] as const;
