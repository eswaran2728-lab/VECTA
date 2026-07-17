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

export const TEAMS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"] as const;
export type Team = (typeof TEAMS)[number];

export const AIRCRAFT_TYPES = ["A320", "A321", "A330"] as const;
export type AircraftType = (typeof AIRCRAFT_TYPES)[number];

export const USER_ROLES = ["OFFICER", "SUPERVISOR", "MANAGER", "ADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const REPORT_TYPES = ["sec016", "sec014", "sec029", "sec018"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

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
};

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
