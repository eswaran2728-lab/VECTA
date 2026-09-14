/**
 * W.O.I.S (Work Order Intelligence Smartbook) - Core Knowledge Base
 * Real PDF Ingestion & OCR Page-Attributed SOP Data, Regulatory Standards & VECTA App Guides.
 *
 * PROCESS NOTE (found 2026-09-14): the "doc-vecta-app-help" document's OT section
 * described the old manual OT-request flow well after it was replaced by the
 * automatic check-in/check-out-based calculation in lib/avsec/duty/checkin-actions.ts
 * — and because app_help chunks are always surfaced as VERIFIED (see
 * handleAppHelpResponse in lib/wois/engine.ts), W.O.I.S confidently gave wrong
 * answers about it. This file is hand-maintained and has no automated link to the
 * app behavior it documents, so nothing flags it when a described feature changes.
 * There is currently no process that re-checks this file when the underlying
 * feature it documents changes — whoever ships a behavior change here should also
 * update the matching app_help chunk in the same PR, and it's worth adding a
 * lint/checklist step for that rather than relying on someone remembering.
 */

import type { WoisSourceType } from "@/lib/avsec/types";

export interface KnowledgeDocumentSeed {
  id: string;
  title: string;
  source_type: WoisSourceType;
  version: string;
  is_official?: boolean;
  metadata?: Record<string, unknown>;
  file_url?: string;
  content: string;
  chunks: {
    section_title: string;
    page_number?: number;
    content: string;
    keywords: string[];
    roleScope?: string[];
    metadata?: Record<string, unknown>;
  }[];
}

export const WOIS_KNOWLEDGE_DOCUMENTS: KnowledgeDocumentSeed[] = [
  {
    id: "doc-wois-sop-manual",
    title: "AirAsia AVSEC W.O.I.S Standard Operating Procedures (SOP) Manual",
    source_type: "sop",
    version: "2026.1",
    file_url: "/api/wois/documents/W_O_I_S.pdf",
    content: `# AirAsia AVSEC W.O.I.S Standard Operating Procedures (SOP) Manual

## 1. Make-Up Area (Pages 3–11)
### 1.1 Types of Baggage & Reconciliation Procedures at Make-Up (Pages 3–10)
- System Method: Container Reconcile Card (CRC), Container Card (every container), Final Card / Delivery Card (summary of each departure).
- Make-Up Domestic & International: Scanning via Baggage Reconciliation System (BRS) by ramp staff.
- Make-Up Area Security:
  * Position at Make-Up zones as rostered.
  * Only authorized personnel with physical identification cards permitted at Make-Up Area.
  * Record baggage handlers name and staff number.
  * Physical check on baggage condition.
  * Frisk baggage handlers after their duties.
  * Monitor baggage loaded into the right containers/trolleys with the right baggage tag.
  * Prevent pilferage and sabotage. Submit all recorded details as an E-daily report.
- Types of Baggage Tags:
  * Fly-Thru / Transit / Transfer: Yellow Colour Tag (continue next stop arrival).
  * Hi-Flyer / Express: Green Colour Tag (fast out at arrival).
  * Commercial / Local: White Colour Tag (passenger baggage).
  * Crew Bag: Crew Tag (crew baggage).
  * Company Mail (COMAIL): Comail Label.
  * Company Material (COMAT): Comat Label.
- Reconciliation Procedures at Make-Up:
  * Check total numbers based on CRC or BRC.
  * Total number of checked-in baggage must equal baggage manifest.
  * Golden Rule: **RIGHT BAG, RIGHT TAG, RIGHT DESTINATION**.
  * Reconciliation at Make-Up is conducted by Ramp Staff.

### 1.2 Reconciliation Procedures at Apron (Page 11)
- Baggage reconciliation and detection by Airport Security on restricted article / item.
- Guest Service to notify / call the passenger.
- Ramp Leader and AirAsia AVSEC witness reconciliation at Parking Bay Hammerhead.
- AirAsia AVSEC must NOT accept any item detected during reconciliation; confiscated items remain under Malaysia Airports (MA) AVSEC custody.
- At completion of reconciliation, AA AVSEC sends report to Security Officer.
- If an item is confiscated, AA AVSEC submits an email report to the Security Officer.
- Detection of vape devices as Checked-In Baggage in Significant Quantities (Security Instruction MAA 01/2026): The baggage must be offloaded along with the passenger owing to false declaration.

---

## 2. Break-Up Area Security (Pages 12–13)
- Position at Break-Up Area as per daily operation roster.
- Only authorized personnel permitted at Break-Up Area.
- Record baggage handlers name and staff number.
- Ensure each baggage has the right bag tag; perform physical check on baggage condition.
- Frisk baggage handlers after their duties.
- Prevent pilferage and sabotage.
- Submit all recorded details as an E-daily report.

---

## 3. Ramp Guard Security (Pages 14–15)
- Ensure only authorized personnel and vehicles are permitted within the vicinity of the aircraft.
- Monitor and enforce ground safety regulations.
- Prevent pilferage and sabotage.
- Frisk all ground personnel approaching the aircraft.
- Submit all recorded details as an E-daily report.

---

## 4. Step Guard Security (Pages 16–17)
- Stationed at aircraft boarding stairs and passenger loading bridges.
- Check and frisk ground personnel, tools, and equipments prior to entering and after exiting the aircraft.
- Verify passenger boarding passes and ensure passengers follow the sterile path to the aircraft.
- Prevent unauthorized tools or prohibited articles from entering the cabin.
- Submit all recorded details as an E-daily report.

---

## 5. Hold Guard Security (Pages 18–19)
- Stationed at cargo compartments during all loading and unloading operations.
- Observe loading and unloading activities.
- Enforce **RIGHT BAG, RIGHT TAG, RIGHT DESTINATION**.
- Check Aircraft Hold (Turnaround / Long Layover LLO / Night Stop): Front Hold & Rear Hold.
- **Positioning Rule**: Position SHALL be at the **OPPOSITE DIRECTION** of the loading or unloading process.
- Prevent pilferage, sabotage, misrouted baggage/cargo, and overcarried baggage/cargo.
- Submit all recorded details as an E-daily report.

---

## 6. Security Check & Aircraft Search (Pages 20–33)
### 6.1 Security Check vs Aircraft Search Distinction (Page 20)
- **Aircraft Security Check**: Conducted by **Cabin Crew** internally to detect left-behind items and maintain aircraft sterility.
- **Aircraft Search**: Conducted by **AirAsia AVSEC** for Long Layover (LLO), Night Stop, or Tow from Hangar.
- Official Forms:
  * E-Form: **AA/SEC/F/029 REV.03** (SEC029 Aircraft Search Report).
  * E-Form: **AA/SEC/F/035 Rev.07**.
  * Procedure for detected prohibited item or security irregularities: Refer to Aircraft Search SOP Sub-Chapter 5.0.
  * Left-Behind Items: AA AVSEC raises Acknowledgement Form (**AA/SEC/F/007 REV.02**), hands item to CBTO, and notifies Security Officer.

### 6.2 Aircraft Search Direction & Minimum Timings (Pages 21–22)
- Internal security check begins from **AFT (Rear Galley) to FORWARD (Cockpit)**.
- **Minimum Aircraft Search Timings**:
  * **Airbus A320 / A321**: **Not less than 30 minutes**.
  * **Airbus A330**: **Not less than 45 minutes**.
- Any irregularities detected must be reported immediately to the Security Officer / Security Executive.

### 6.3 Systematic Internal Search Zones (Pages 24–29)
1. **Cockpit (Page 25)**: Panels, observer seats, emergency equipment compartments, control pedestal. *Important: Do not touch any active switches/panels in cockpit.*
2. **Galleys (Pages 26–27)**: All compartments, Meal Storage Units (MSU), ovens, meal carts, ceiling areas, and surrounding spaces.
3. **Cabin Seats (Page 28)**: Between seats, under seats, chair tables, fuselage, seat pockets, life jacket pouches. Check behind First Aid and Medical Kits (ensure unsealed condition verified).
4. **Lavatories (Page 29)**: Baby nappy changing table, lavatory doors, mirror compartments, walls, ceiling, floor, and waste chutes.

### 6.4 External Aircraft Search — 18 Walk-Around Points (Pages 31–32)
1. Left Forward Fuselage, 2. Nose, 3. Landing Gear, 4. Right Forward Fuselage, 5. Right Centre Fuselage, 6. Right Centre Wing, 7. Right Engine, 8. Right Wing Leading Edge, 9. Right Wing Tip, 10. Right Wing Trailing Edge, 11. Rear Landing Gear, 12. Right Aft Fuselage, 13. Tail & APU, 14. Left Aft Fuselage, 15. Left Wing Trailing Edge, 16. Left Wing Tip, 17. Left Wing Leading Edge, 18. Left Engine.
- *Important Rule*: Do not tamper with or remove any security seals.

---

## 7. Aircraft Guard & Unattended Aircraft (Page 31)
- Aircraft unattended at bays or hangars must be guarded or sealed with tamper-evident seals.
- Check and verify seal numbers before crew handover.

---

## 8. Patrolling Landside (Pages 34–35)
- Area: Check-In Counters & Surrounding Areas.
- Attend briefing with Security Officer.
- Identify & report: Suspicious behaviour, unattended baggage, touts/unauthorized individuals, medical emergencies, fire alarms, security breaches.
- Contact Security Operation Center (SOC) to keep situation under control before SO arrival.

---

## 9. Patrolling Airside (Pages 36–37)
- Area: Aircraft Parking Bays.
- Collection of all security tools/items for patrolling.
- Attend briefing with Security Officer. Conduct patrolling of designated areas.
- Submit daily report at end of shift to the Security Officer.
- Monitor surroundings, suspicious movements, and unauthorized personnel in aircraft vicinity.

---

## 10. Disruptive & Unruly Passengers (Pages 38–40)
### 10.1 Disruptive vs Unruly Definition (Page 38)
- **Disruptive Passenger**: Causes disturbance, arguing with Ground Staff (GS), managed to calm passenger.
- **Unruly Passenger**: Violates rules, threatens safety & security. Further action assisted by Malaysia Airports SOC / PDRM.
- **Rule**: *"Every unruly passenger is disruptive, but not every disruptive passenger is unruly."*

### 10.2 Handling Unruly Passengers Process (Page 39)
1. Proceed to the scene (gate / aerobridge / aircraft).
2. Brief the passenger regarding airline procedures.
3. Escort complainant and disruptive passenger to Airport Police Station together with MA SOC personnel.
4. Submit Incident Report (HDP) within 24 hours.

### 10.3 Handling Potentially Disruptive Passengers (Page 40)
- Sufficient information of potential disruptive passenger (including inadmissible passengers and unescorted deportees) must be provided to Station Manager.
- Notification to Pilot-in-Command (PIC) on duty done by Station Manager / AirAsia representative assigned by Station Manager.`,
    chunks: [
      {
        section_title: "Make-Up Area (BMA) - Cards & BRS System Method",
        page_number: 3,
        content: "Container Reconcile Card (CRC), Container Card (every container), and Final Delivery Card (departure summary). Scanning via Baggage Reconciliation System (BRS) by ramp staff for Domestic and International departures.",
        keywords: ["brs", "crc", "container reconcile card", "container card", "delivery card", "make up area", "bma", "baggage reconciliation"],
      },
      {
        section_title: "Make-Up Area - Physical Access & Frisking Duties",
        page_number: 4,
        content: "Position at Make-Up zones as rostered. Only authorized personnel allowed. Record baggage handlers name and staff number. Physical check on baggage condition. Frisk baggage handlers after duties. Monitor baggage loaded into containers/trolleys with right tags.",
        keywords: ["makeup area duties", "frisk baggage handlers", "access control make up", "baggage handlers", "record name staff number"],
      },
      {
        section_title: "Types of Baggage Tags (Fly-Thru, Hi-Flyer, Crew, COMAIL)",
        page_number: 6,
        content: "Fly-Thru/Transit/Transfer: Yellow Colour Tag. Hi-Flyer/Express: Green Colour Tag (fast out). Commercial/Local: White Colour Tag. Crew Bag: Crew Tag. Company Mail: COMAIL Label. Company Material: COMAT.",
        keywords: ["baggage tag colours", "yellow tag", "green tag", "white tag", "crew bag", "comail", "comat", "hi flyer", "fly thru", "transit tag"],
      },
      {
        section_title: "Make-Up Reconciliation - Right Bag, Right Tag, Right Destination",
        page_number: 10,
        content: "Check total numbers based on CRC or BRC against baggage manifest. Mandatory standard: RIGHT BAG, RIGHT TAG, RIGHT DESTINATION. Reconciliation at Make-up is conducted by Ramp Staff.",
        keywords: ["right bag right tag right destination", "baggage manifest", "crc check", "make up reconciliation"],
      },
      {
        section_title: "Apron Reconciliation & Vape Confiscation Protocol",
        page_number: 11,
        content: "Airport Security detection of restricted items: Guest Service notifies passenger. Ramp Leader and AA AVSEC witness reconciliation at Bay Hammerhead. Confiscated items kept under MA AVSEC custody. AA AVSEC sends report to SO. Significant quantities of vape devices in checked baggage (SI MAA 01/2026): baggage and passenger offloaded for false declaration.",
        keywords: ["vape", "vape in checked baggage", "apron reconciliation", "hammerhead", "confiscated item", "ma avsec custody", "si maa 01/2026", "offload passenger vape"],
      },
      {
        section_title: "Break-Up Area (BBA) - Inbound Baggage Supervision",
        page_number: 12,
        content: "Position at Break-Up Area as per roster. Only authorized personnel. Record handlers name and staff ID. Physical check on baggage condition. Ensure right bag tags. Frisk handlers after duties. Prevent pilferage and sabotage; submit E-daily report.",
        keywords: ["break-up area", "bba", "breakup area", "inbound baggage", "frisk handlers breakup"],
      },
      {
        section_title: "Ramp Guard - Safety Zone & Service Provider Access",
        page_number: 14,
        content: "Ensure only authorized personnel and vehicles permitted within aircraft vicinity. Monitor ground safety regulations. Prevent pilferage and sabotage. Frisk personnel and submit E-daily report.",
        keywords: ["ramp guard", "aircraft vicinity", "ground safety", "frisk ramp", "e-daily report"],
      },
      {
        section_title: "Step Guard - Boarding Stair & Tool Inspection",
        page_number: 16,
        content: "Stationed at boarding stairs/bridges. Check and frisk ground personnel, tools and equipments prior to entering and exiting aircraft. Monitor boarding passengers, verify boarding passes, prevent unauthorized tools.",
        keywords: ["step guard", "boarding stairs", "frisk tools", "ground personnel tools", "boarding bridge"],
      },
      {
        section_title: "Hold Guard - Cargo Hold Surveillance & Positioning Rule",
        page_number: 18,
        content: "Observe loading/unloading activities for Front and Rear Holds. POSITION SHALL BE AT OPPOSITE DIRECTION OF LOADING OR UNLOADING PROCESS. Prevent pilferage, sabotage, misroute, and overcarried baggage.",
        keywords: ["hold guard", "opposite direction", "cargo hold position", "front hold", "rear hold", "misrouted baggage", "overcarried"],
      },
      {
        section_title: "Aircraft Search vs Security Check & E-Forms",
        page_number: 20,
        content: "Security Check conducted by Cabin Crew internally (maintain sterility). Aircraft Search conducted by AA AVSEC for Long Layover (LLO), Night Stop, or Tow from Hangar. E-Forms: AA/SEC/F/029 REV.03 (SEC029) and AA/SEC/F/035 Rev.07. Left behind items: Raise Acknowledgement Form AA/SEC/F/007 REV.02, handover to CBTO, notify SO.",
        keywords: ["security check vs aircraft search", "aa/sec/f/029", "sec029", "left behind item", "aa/sec/f/007", "cbto", "night stop search", "hangar search"],
      },
      {
        section_title: "Aircraft Search Minimum Timings & Search Direction",
        page_number: 22,
        content: "Aircraft Search minimum duration: A320 / A321 not less than 30 mins; A330 not less than 45 mins. Search must proceed systematically from Rear Galley (AFT) to Cockpit Area (FORWARD). Report irregularities to SO/DSE.",
        keywords: ["aircraft search timing", "a320 search time", "a321 search time", "a330 search time", "30 mins", "45 mins", "aft to forward", "search duration"],
      },
      {
        section_title: "Systematic Search Zones (Cockpit, Galleys, Seats, Lavatory)",
        page_number: 25,
        content: "Internal zones from AFT to FORWARD: Cockpit (do not touch active panels), Galleys (MSU, ovens, meal carts), Cabin Seats (between/under seats, chair tables, check behind First Aid/Medical kits), Lavatories (nappy changing area, mirrors, ceiling, floor, waste chutes).",
        keywords: ["search zones", "cockpit search", "galley search", "seat search", "lavatory search", "first aid kit check", "msu"],
      },
      {
        section_title: "External Aircraft Search - 18 Walk-Around Inspection Points",
        page_number: 31,
        content: "18 walk-around search points around fuselage, nose, landing gears, engines, wings, and tail/APU. Purpose is to detect safety/security compromises. Do not tamper with or remove security seals.",
        keywords: ["18 points", "walk around", "external search", "landing gear search", "engine search", "apu search"],
      },
      {
        section_title: "Landside Patrolling (Check-In & Surrounding Areas)",
        page_number: 34,
        content: "Briefing with SO. Identify & report: Suspicious behaviour, unattended baggage, touts/unauthorized individuals, medical emergencies, fire alarms, security breaches. Contact SOC to keep situation under control before SO arrival.",
        keywords: ["landside patrol", "check in patrol", "unattended baggage", "touts", "soc", "security operation center"],
      },
      {
        section_title: "Airside Patrolling (Aircraft Parking Bays)",
        page_number: 36,
        content: "Collect security tools. Attend briefing with SO. Patrol designated bays. Submit daily report at end of shift. Monitor surroundings, suspicious movements, and unauthorized personnel in aircraft vicinity.",
        keywords: ["airside patrol", "parking bay patrol", "apron patrol", "bay security"],
      },
      {
        section_title: "Disruptive vs Unruly Passenger Definitions",
        page_number: 38,
        content: "Disruptive Passenger: Causes disturbance, arguing with Ground Staff, calmed down. Unruly Passenger: Violates rules, threatens safety & security, assisted by MA SOC/PDRM. Rule: 'Every unruly passenger is disruptive, but not every disruptive passenger is unruly.'",
        keywords: ["disruptive vs unruly", "unruly passenger", "disruptive passenger", "every unruly passenger is disruptive", "pdrm", "soc unruly"],
      },
      {
        section_title: "Handling Unruly Passengers - Escalation & Police Handover",
        page_number: 39,
        content: "Proceed to scene. Brief passenger about airline procedures. Escort complainant and disruptive passenger to Airport Police Station together with MA SOC. Submit Incident Report (HDP) within 24 hours.",
        keywords: ["handling unruly passenger", "police station escort", "hdp", "incident report 24 hours"],
      },
      {
        section_title: "Potentially Disruptive Passengers & Deportee Notification",
        page_number: 40,
        content: "Sufficient info regarding potential disruptive passengers (inadmissible passengers, unescorted deportees) provided to Station Manager. Station Manager or assigned AirAsia representative notifies Pilot-in-Command (PIC) on duty.",
        keywords: ["deportee", "inadmissible passenger", "potentially disruptive", "notify pic", "pilot in command notification"],
      },
    ],
  },
  {
    id: "doc-vecta-app-help",
    title: "VECTA Operations Suite — User & Feature Guide",
    source_type: "app_help",
    version: "2026.1",
    content: `# VECTA Operations Suite — In-App Help Guide

## SEC 016 (Aircraft Attendance Report)
- Flight Type Selector: Located at top of form. Must select either 'Arrival' or 'Departure'.
- Smart OCR Parse: Tap 'Scan GCR / Flight Sheet' to automatically extract Flight Number, Aircraft Reg, Bay, STD/STA, and Aircraft Type from paper sheets or screenshots.
- Bay Board Auto-Link: When submitting an Arrival SEC016, an active Bay Board card is created automatically with ground time tracking. When submitting a Departure SEC016 with 'Completed Search' checked, the Bay Board aircraft is marked cleared and archived.
- 4-Hour Aircraft Search Rule: If an aircraft remains on the ground for >= 4 hours between arrival and departure, VECTA displays an amber warning requiring a mandatory full aircraft security search (SEC 029).

## Overtime (OT) — Automatic Calculation & Approval
- There is no manual "submit an OT request" step in the current system — this replaced the old manual-request flow entirely. OT is calculated automatically from your actual Duty Check-In and Check-Out timestamps.
- Early check-in OT: checking in 30+ minutes before your scheduled shift start automatically creates a pending OT request the moment you check in.
- Late check-out OT: checking out 30+ minutes after your scheduled shift end (or, on an off-day with no scheduled shift, for the full worked duration) automatically creates a pending OT request the moment you check out.
- Approval workflow: your DSE (Duty Security Executive) endorses the auto-generated request for their own station/team; DSE or Management then approves or rejects it. You can withdraw your own request only while it's still pending, under Duty -> Overtime.
- SO (Security Officer) does not endorse or approve OT — only DSE and Management do.

## Duty Check-In & Check-Out
- Check-In: Tap 'Duty Check-In' on the home screen at the start of your shift. Scans your location/station.
- Check-Out: Tap 'Duty Check-Out' when ending your shift to record completed shift duration into the official timesheet.

## Anonymous Staff Feedback
- Purpose: Submit safety concerns, complaints, suggestions, or general feedback directly to Management with guaranteed anonymity.
- How to submit: Tap 'Staff Feedback' -> 'Submit Feedback' -> choose Category (Safety Concern, Complaint, Suggestion, Other) and enter description.
- Submitter privacy: Management can never view who submitted feedback. Two-way chat lets you reply to management inquiries anonymously.

## Management Announcements
- Purpose: Broadcast official operational directives and announcements from Management to staff.
- Staff viewing: Active announcements appear directly as cards/banners at the top of your Staff Dashboard.
- Read Receipt: Tap 'Acknowledge' on each announcement to record your read confirmation.

## Bay Board
- Purpose: Real-time aircraft ground movement and turnaround monitor for Operation AVSEC and Hub AVSEC.
- Color codes: Green (< 3 hrs ground time), Amber (3 to 4 hrs ground time), Red (> 4 hrs overdue ground time requiring mandatory SEC029 search). Note: Bay Board is scoped exclusively to Operation and Hub AVSEC branches.`,
    chunks: [
      {
        section_title: "SEC 016 Aircraft Attendance Guide",
        content: "To fill SEC016, select 'Arrival' or 'Departure' at the top. Use 'Scan GCR / Flight Sheet' for Smart OCR auto-population. Submitting Arrival auto-creates a Bay Board card. Submitting Departure with search completed clears the Bay Board. Aircraft on ground > 4 hours triggers mandatory search rule.",
        keywords: ["how to fill sec016", "sec016", "aircraft attend", "arrival departure toggle", "smart parse", "ocr", "4 hour rule", "bay board link"],
      },
      {
        section_title: "Overtime (OT) Automatic Calculation Guide",
        content: "OT is fully automatic — there is no manual 'submit an OT request' step; that older flow has been replaced. Checking in 30+ minutes early or checking out 30+ minutes late automatically creates a pending OT request from your actual check-in/check-out timestamps. Your DSE endorses it for your station/team, then DSE or Management approves or rejects it. You can withdraw your own request only while it's still pending, under Duty -> Overtime. SO does not endorse or approve OT.",
        keywords: ["how to submit ot", "overtime", "submit ot", "ot request", "dse approval", "ot approval", "apply ot", "automatic overtime", "auto ot", "ot calculation"],
      },
      {
        section_title: "Duty Check-In and Timesheet Guide",
        content: "Tap 'Duty Check-In' on your home screen when starting your shift to log your duty start time. Tap 'Duty Check-Out' at shift end to record shift completion on your attendance timesheet.",
        keywords: ["duty check in", "check out", "timesheet", "how to check in", "clock in", "roster check in"],
      },
      {
        section_title: "Anonymous Staff Feedback Guide",
        content: "Staff can submit anonymous feedback by navigating to Staff Feedback -> Submit Feedback. Select category (Safety Concern, Complaint, Suggestion, Other). Submitter identity is protected by database security and never shown to Management. You can chat two-way with Management anonymously.",
        keywords: ["how to submit feedback", "anonymous feedback", "safety concern", "complaint", "feedback chat", "submit suggestion"],
      },
      {
        section_title: "Management Announcements Guide",
        content: "Management Announcements appear as prominent banners at the top of the Staff Dashboard. Staff can read company directives and tap 'Acknowledge' to submit instant read receipts.",
        keywords: ["announcements", "acknowledge announcement", "read announcements", "broadcasts"],
      },
      {
        section_title: "Bay Board Operational Guide",
        content: "Bay Board tracks aircraft on ground across airport parking bays. Color coded: Green (< 3 hours), Amber (3-4 hours), Red (> 4 hours overdue for search). Scoped to Operation AVSEC and Hub AVSEC (does not apply to IFC AVSEC).",
        keywords: ["bay board", "aircraft ground time", "overdue aircraft", "bay monitor", "operation avsec bay"],
      },
    ],
  },
  {
    id: "doc-aviation-regulatory",
    title: "General Aviation Security & Dangerous Goods Reference",
    source_type: "regulatory",
    version: "2026.1",
    is_official: false,
    metadata: {
      is_official: false,
      summary_type: "plain_language_summary",
      note: "Original plain-language summary, not an official IATA/ICAO/AirAsia document",
    },
    content: `# General Aviation Security & Dangerous Goods Reference (Original Summary)

**Purpose**: A plain-language reference for W.O.I.S AI's GENERAL KNOWLEDGE tier — standard industry practice, not an official IATA/ICAO/AirAsia document. Always tag answers built from this as GENERAL KNOWLEDGE with a "verify against current AirAsia policy/SOP" caveat, since official rules can be stricter, more detailed, or updated over time.

---

## 1. Dangerous Goods — the 9 Classes (general structure)
Dangerous goods carried by air are grouped into nine broad hazard classes, each with subdivisions:
1. **Explosives** — fireworks, ammunition, blasting agents
2. **Gases** — flammable, non-flammable/non-toxic, and toxic gases (e.g. aerosols, gas cylinders, lighters)
3. **Flammable liquids** — fuels, solvents, paints, alcohol-based products
4. **Flammable solids** — matches, substances liable to spontaneous combustion, substances dangerous when wet
5. **Oxidizing substances & organic peroxides** — bleaches, certain fertilizers
6. **Toxic & infectious substances** — pesticides, medical/biological samples
7. **Radioactive material** — medical isotopes, industrial sources
8. **Corrosives** — battery acid, certain cleaning agents
9. **Miscellaneous dangerous goods** — items that don't fit classes 1–8 but still pose a hazard in air transport, including lithium batteries, magnetized material, and dry ice

This structure is common across IATA DGR, ICAO Technical Instructions, and most national regulators (CAAM, FAA, EASA).

---

## 2. Lithium Batteries (the most common staff-facing question)
Lithium batteries are regulated separately because of fire risk (thermal runaway). Two types:
- **Lithium-ion (rechargeable)** — laptops, phones, power banks, e-cigarettes
- **Lithium-metal (non-rechargeable)** — many camera batteries, some medical devices

**Common general carry rules** (industry-standard, verify against current AirAsia policy):
- Spare/loose lithium batteries (including power banks) are typically **carry-on only** — never in checked baggage, because a fire in the cabin can be detected and managed by crew, while one in the cargo hold cannot.
- Devices *containing* a battery (phone, laptop) are usually fine in checked baggage, but airlines increasingly prefer carry-on for these too.
- **Watt-hour (Wh) limits** are the standard measure of battery "size" for this purpose:
  * Up to **100Wh**: generally allowed without special airline approval (covers the vast majority of phone, laptop, and consumer power bank batteries).
  * **100–160Wh**: usually allowed only with airline approval, and often limited in quantity (e.g. two spares per passenger).
  * **Above 160Wh**: generally forbidden on passenger aircraft.
- To estimate Wh from a power bank's printed capacity: \`Wh ≈ (mAh ÷ 1000) × voltage\`. Most power banks are rated at 3.7V internally, so a 20,000mAh power bank is roughly 20 × 3.7 ≈ **74Wh** — typically within the standard 100Wh allowance, but the exact figure depends on what's printed on the specific unit, and the final call should always follow AirAsia's own policy/SOP, not this estimate.
- Damaged, recalled, or swelling batteries are refused regardless of Wh rating.

---

## 3. Commonly Prohibited/Restricted Cabin Items (general reference)
- Sharp objects (knives, scissors above a small blade length, razor blades)
- Blunt weapons (bats, clubs)
- Firearms and ammunition (checked baggage only, with declaration/approval)
- Flammable liquids/gels above standard liquid limits (commonly 100ml per container in many jurisdictions, though this varies)
- Self-defense sprays (pepper spray, mace) — typically prohibited entirely
- Tools above a certain length (screwdrivers, wrenches)
- Realistic replica weapons

Exact thresholds and enforcement vary by country/airport authority — this list is a general orientation, not a definitive restricted-items list. Staff should always defer to the checkpoint's official restricted-items reference for enforcement decisions.

---

## 4. Baggage/Cargo Security Concepts (general terms staff may encounter)
- **Reconciliation**: matching every piece of checked baggage physically loaded onto an aircraft against the passengers actually on board — a passenger who checks in bags but doesn't board should have their bags offloaded.
- **Positive Passenger-Baggage Match (PPBM)**: the underlying security principle behind reconciliation — no bag flies without its owner on the same flight (with defined exceptions for interline/connecting baggage under specific rules).
- **Chain of custody**: an unbroken, documented record of who handled an item (cargo, catering, baggage) from origin to aircraft, used to detect tampering or unauthorized access.
- **Sterile area / airside**: the security-controlled zone beyond screening, where only screened passengers, crew, and authorized personnel/vehicles are permitted.

---

## 5. Regulatory Bodies (who sets these rules, general orientation)
- **ICAO** (International Civil Aviation Organization) — UN body setting global standards (the "Annexes," including Annex 17 for security and Annex 18 for dangerous goods) that member states adopt into national law.
- **IATA** (International Air Transport Association) — airline industry body; publishes detailed operational manuals (like the DGR) that airlines commonly adopt as their working standard, often stricter/more detailed than the bare ICAO minimum.
- **CAAM** (Civil Aviation Authority of Malaysia) — Malaysia's national regulator; enforces ICAO standards domestically and can set additional national requirements.
- **FAA / EASA** — equivalent national/regional regulators for the US and Europe, relevant mainly for aircraft manufactured there or international comparison.`,
    chunks: [
      {
        section_title: "Dangerous Goods — the 9 Hazard Classes",
        content: "Dangerous goods carried by air are grouped into 9 hazard classes: Class 1 Explosives (fireworks, ammunition), Class 2 Gases (flammable, non-flammable, toxic, aerosols, cylinders), Class 3 Flammable liquids (fuels, solvents, paints, alcohol), Class 4 Flammable solids (matches, spontaneous combustion, dangerous when wet), Class 5 Oxidizing substances & organic peroxides (bleaches, fertilizers), Class 6 Toxic & infectious substances (pesticides, biological samples), Class 7 Radioactive material (medical isotopes), Class 8 Corrosives (battery acid, cleaning agents), Class 9 Miscellaneous (lithium batteries, magnetized material, dry ice). Common across IATA DGR, ICAO TI, CAAM, FAA, EASA.",
        keywords: ["dangerous goods", "9 classes", "hazard classes", "class 1", "class 2", "class 3", "class 4", "class 5", "class 6", "class 7", "class 8", "class 9", "explosives", "flammable liquids", "corrosives", "toxic substances", "radioactive", "dry ice", "dgr"],
      },
      {
        section_title: "Lithium Batteries & Power Bank Carry Rules (Wh Limits)",
        content: "Lithium-ion (rechargeable - laptops, phones, power banks, e-cigarettes) and Lithium-metal (non-rechargeable - camera batteries, medical devices). Carry rules: Spare/loose lithium batteries and power banks are CARRY-ON ONLY (strictly never in checked baggage due to thermal runaway risk). Watt-hour (Wh) limits: Up to 100Wh is generally allowed without special airline approval (covers most phones, laptops, and consumer power banks); 100–160Wh is allowed only with airline approval (often limited to 2 spares per passenger); Above 160Wh is generally forbidden on passenger aircraft. Estimation formula: Wh ≈ (mAh ÷ 1000) × voltage. At internal 3.7V, a 20,000mAh power bank is roughly 20 × 3.7 ≈ 74Wh (within standard 100Wh allowance). Damaged, recalled, or swelling batteries are refused regardless of Wh rating.",
        keywords: ["power bank", "lithium battery", "lithium ion", "lithium metal", "watt hour", "wh", "wh limit", "100wh", "160wh", "20000mah", "20000 mah", "mah to wh", "carry on only", "thermal runaway", "swelling battery", "recalled battery", "powerbank", "can a 20,000mah power bank board"],
      },
      {
        section_title: "Commonly Prohibited & Restricted Cabin Items",
        content: "General orientation on restricted cabin items: Sharp objects (knives, scissors above small blade length, razor blades), Blunt weapons (bats, clubs), Firearms and ammunition (checked baggage only with declaration/approval), Flammable liquids/gels above standard liquid limits (commonly 100ml per container in clear plastic bag), Self-defense sprays (pepper spray, mace - typically prohibited entirely), Tools above certain length (screwdrivers, wrenches), Realistic replica weapons. Thresholds vary by authority; staff must defer to checkpoint's official restricted-items reference.",
        keywords: ["prohibited items", "restricted cabin items", "cabin items", "sharp objects", "knives", "scissors", "blunt weapons", "firearms", "lags", "100ml", "pepper spray", "mace", "replica weapons", "tools"],
      },
      {
        section_title: "Baggage & Cargo Security Concepts",
        content: "Key security concepts: 1. Reconciliation: matching every checked bag physically loaded onto an aircraft against boarded passengers; unboarded passenger bags must be offloaded. 2. Positive Passenger-Baggage Match (PPBM): underlying security principle that no bag flies without its owner on the same flight (subject to interline exceptions). 3. Chain of Custody: unbroken, documented record of who handled an item (cargo, catering, baggage) from origin to aircraft to detect tampering or unauthorized access. 4. Sterile Area / Airside: security-controlled zone beyond screening where only screened passengers, crew, and authorized personnel/vehicles are permitted.",
        keywords: ["reconciliation", "positive passenger baggage match", "ppbm", "chain of custody", "sterile area", "airside", "baggage security concepts", "cargo security"],
      },
      {
        section_title: "Aviation Regulatory Bodies (ICAO, IATA, CAAM, FAA, EASA)",
        content: "Overview of regulatory bodies: ICAO (UN body setting global Annex 17 security and Annex 18 dangerous goods standards adopted into national law); IATA (airline industry body publishing operational manuals like DGR often adopted as airline working standard); CAAM (Civil Aviation Authority of Malaysia, enforces ICAO standards domestically and sets national requirements); FAA & EASA (US and European regional aviation regulators).",
        keywords: ["regulatory bodies", "icao", "iata", "caam", "faa", "easa", "annex 17", "annex 18", "civil aviation authority of malaysia"],
      },
    ],
  },
  {
    id: "doc-general-aviation-kb",
    title: "General Aviation Knowledge Base",
    source_type: "regulatory",
    version: "2026.1",
    is_official: false,
    metadata: {
      is_official: false,
      summary_type: "comprehensive_aviation_kb",
      modules_count: 19,
      note: "Comprehensive industry-standard aviation knowledge base (conceptual reference, not official AirAsia policy)",
    },
    content: `# General Aviation Knowledge Base (Comprehensive Reference)

## 1. Aviation Fundamentals
Standardized terminology (ATC, ATIS, AVSEC, DGR, GSE, FOD, ULD, ETA, ETD, RWY, TWY, APRON). Aircraft types (Jet vs Propeller, Fixed-wing vs Rotorcraft). Flight phases (Preparation, Boarding, Pushback, Taxi, Takeoff, Climb, Cruise, Descent, Approach, Landing, Turnaround). Four forces of flight (Lift, Weight, Thrust, Drag). Aircraft axes (Roll/Ailerons, Pitch/Elevators, Yaw/Rudder).

## 2. Airport Operations
Landside vs Airside zones. Terminal operations, Apron operations, Runway incursions, Taxiways, Stands, Airport markings and lighting.

## 3. Aircraft Knowledge
Structures (Fuselage, Wings, Empennage, Landing Gear). Flight controls (Primary and Secondary). Engines, Landing gear, Cargo compartments, Fuel systems, Narrow-body vs Wide-body, Passenger vs Freighter.

## 4. Flight Operations
Flight planning, Pushback, Taxi, Takeoff, Climb, Cruise, Descent, Approach, Landing, Parking, Turnaround operations.

## 5. AVSEC (Aviation Security)
Access control, Screening (passenger, baggage, personnel, vehicle, cargo), Restricted areas, Security ID verification, Personnel & Vehicle security, Aircraft security, Catering security, Cargo security, Baggage reconciliation, Patrol, Incident reporting, Security response (Detect -> Assess -> Control -> Notify -> Escalate -> Document), Chain of custody.

## 6. Ground Operations
Ground handling, Ramp safety, GSE, Turnaround, Marshalling signals, Towing, Refueling safety, Servicing.

## 7. GSE Knowledge
GPU, ASU, Belt Loader, Pushback Tug, Tow Tractor, Catering High-Loader, Passenger Stairs, Water Truck, Lavatory Truck, Baggage Tractor, Cargo Loader.

## 8. Catering Operations
Catering vehicles, High-lift trucks, Food carts, Tamper-evident seals, Vehicle inspection, Driver verification, Loading, Delivery, Catering chain of custody, Security checkpoints.

## 9. Cargo Operations
Cargo acceptance, Cargo screening, Secure cargo status, ULD pallets/containers, Cargo loading, Documentation (AWB), Transfer operations.

## 10. Dangerous Goods
DGR principles, 9 Hazard Classes, Labels/markings, Lithium battery carry rules, Handling, Storage, Transport, Emergency response.

## 11. Ramp Safety
FOD (Foreign Object Debris), Jet blast, Propeller hazards, Engine intake suction danger zones, Vehicle movements, Clearances, PPE requirements, Safe approach distances.

## 12. Emergency Management
Aircraft emergency, Fire response, Security incidents, Bomb threats, Suspicious items, Unauthorized persons/vehicles, Medical emergencies, Evacuation, Escalation levels.

## 13. Aviation Regulations & Organizations
ICAO, IATA, CAAM, FAA, EASA, SARPs, SMS frameworks.

## 14. ICAO Annexes (Annex 1 to 19)
Complete overview of Annex 1 to 19 (including Annex 17 AVSEC, Annex 18 Dangerous Goods, Annex 19 Safety Management).

## 15. Aviation Terminology & Acronyms
Glossary of abbreviations (ETA, ETD, STD, STA, ATC, ATIS, NOTAM, AOC, AVSEC, DGR, GSE, FOD, ULD, GPU, PPE, RWY, TWY, APRON, AGL, AMSL).

## 16. Human Factors
Situational awareness (Perception -> Understanding -> Prediction), Fatigue risk management, Communication, Teamwork, Decision-making, Error management, Distraction, Stress, Safety culture.

## 17. Safety Management Systems (SMS)
Hazard identification, Risk assessment (Likelihood x Severity), Hierarchy of controls, Safety reporting, Indicators, Corrective & Preventive actions, Root-cause analysis, SMS cycle.

## 18. Security Intelligence (Conceptual)
Threat identification, Suspicious behaviour observation, Anomaly detection (route deviations, permit lapses), Seal discrepancies, Pattern recognition, Incident correlation.

## 19. Airport Vehicles
Vehicle identification, Authorized drivers, Permits, Vehicle inspections, Escort requirements, Airside driving rules.`,
    chunks: [
      {
        section_title: "1.0 General Aviation Fundamentals & Terminology",
        content: "Aviation uses standardized terminology to reduce ambiguity. Key standard terms: Aircraft (machine capable of flight), Airport (facility supporting aircraft operations), Aerodrome (defined area for aircraft movement), Flight (aircraft operation from departure to destination), ATC (Air Traffic Control), ATIS (Automatic Terminal Information Service), AVSEC (Aviation Security), DGR (Dangerous Goods Regulations), GSE (Ground Support Equipment), FOD (Foreign Object Debris/Damage), ULD (Unit Load Device), ETA (Estimated Time of Arrival), ETD (Estimated Time of Departure), RWY (Runway), TWY (Taxiway), APRON (Aircraft parking/servicing area). Communication prioritizes clarity, standardization, and brevity.",
        keywords: ["aviation terminology", "aviation fundamentals", "acronyms", "atc", "atis", "avsec", "gse", "fod", "uld", "eta", "etd", "rwy", "twy", "apron", "standard terms", "what does fod stand for"],
        metadata: { section: "Fundamentals" },
      },
      {
        section_title: "1.2 Aircraft Types, Aerodynamics & Four Forces of Flight",
        content: "Aircraft classifications: By propulsion (Jet: turbofan, turbojet e.g. A320, 737, A350, 787; Propeller: turboprop e.g. ATR 72, Dash 8), configuration (fixed-wing, rotorcraft), purpose (passenger, cargo, military, training). Flight phases: Preparation, Boarding, Pushback, Engine start, Taxi, Takeoff, Climb, Cruise, Descent, Approach, Landing, Parking, Turnaround. Four forces: Lift (upward), Weight (gravity), Thrust (forward engines), Drag (opposing movement); in steady level flight Lift ≈ Weight and Thrust ≈ Drag. Aircraft axes: Longitudinal (Roll/Ailerons), Lateral (Pitch/Elevators), Vertical (Yaw/Rudder).",
        keywords: ["aircraft types", "four forces of flight", "lift", "thrust", "drag", "weight", "flight phases", "aerodynamics", "turbofan", "narrow body", "wide body", "pitch roll yaw"],
        metadata: { section: "Fundamentals" },
      },
      {
        section_title: "2.0 Airport Operations & Airside vs Landside Zones",
        content: "Landside: Public terminal areas, car parks, roads. Airside: Aprons, taxiways, runways, stands, baggage/cargo areas; strictly access-controlled due to safety/security risk. Apron operations: High-risk zone for parking, passenger/baggage/cargo loading, catering, fueling, ground power, pushback. Runway: Takeoff/landing zone; runway incursions are critical safety events. Taxiways: Movement routes between runways, aprons, and stands. Airport markings and signs identify holding positions, centerlines, vehicle lanes, and safety boundaries — always follow approved local procedures.",
        keywords: ["airport operations", "landside vs airside", "airside", "landside", "apron operations", "runway", "taxiway", "aircraft stands", "airport markings", "airport signs", "runway incursion"],
        metadata: { section: "Airport Operations" },
      },
      {
        section_title: "3.0 Aircraft Structures, Controls & Systems",
        content: "Aircraft structures: Fuselage (flight deck, cabin, cargo, systems), Wings (lift generation), Empennage (tail assembly: horizontal/vertical stabilizers, rudder, elevator), Landing gear (nose/main gear, wheels, brakes, steering). Flight controls: Primary (Ailerons for roll, Elevators for pitch, Rudder for yaw); Secondary (Flaps, Slats, Spoilers, Trim). Engines: Turbofan common; hazards include intake suction, jet blast exhaust, hot surfaces, noise. Doors/Exits: Passenger, emergency with evacuation slides, cargo, and service doors (never operate without authorization). Cargo compartments: Netting, locks, smoke detection, and fire suppression systems.",
        keywords: ["aircraft structures", "fuselage", "empennage", "flight controls", "aircraft engines", "landing gear", "aircraft doors", "cargo compartments", "aircraft identification", "freighter"],
        metadata: { section: "Aircraft Knowledge" },
      },
      {
        section_title: "4.0 Flight Operations & Turnaround Sequence",
        content: "Flight operations encompass flight planning (route, weather, fuel, NOTAMs, weight/balance), pushback (tug connection, clearance, pushback, disconnect), taxiing, takeoff (most critical phase), climb, cruise, descent, approach, landing, and parking. Turnaround operations involve disembarkation, cabin cleaning, catering loading/unloading, baggage/cargo offloading/loading, refueling, water/lavatory servicing, security checks, and boarding. Objective: Safe, secure, on-time, and correctly documented.",
        keywords: ["flight operations", "flight planning", "pushback procedure", "taxiing", "takeoff phase", "climb", "cruise", "descent", "approach", "landing", "turnaround operations"],
        metadata: { section: "Flight Operations" },
      },
      {
        section_title: "5.0 Aviation Security (AVSEC) Core Principles",
        content: "Aviation Security (AVSEC) core controls: 1. Access Control: Identity/access cards, permits, biometric gates, escorts. 2. Security Screening: Screening of passengers, cabin baggage, hold baggage, personnel, vehicles, and cargo per approved security programmes. 3. Security Identification: Verify identity, authorization, validity, and zone (never rely on appearance or familiarity). 4. Aircraft Security: Searches, monitoring doors, protecting sterility. 5. Incident Reporting: Factual reporting answering WHO/WHAT/WHEN/WHERE/HOW/ACTION TAKEN/NOTIFIED without unsupported speculation. 6. Security Response: Detect -> Assess -> Control -> Notify -> Escalate -> Document. 7. Chain of Custody: Documented accountability over items across every handover.",
        keywords: ["avsec", "aviation security", "access control", "security screening", "restricted areas", "security identification", "personnel security", "vehicle security", "aircraft security", "patrol operations", "incident reporting", "unauthorized access", "chain of custody"],
        metadata: { section: "AVSEC" },
      },
      {
        section_title: "6.0 Ground Operations & Ramp Safety Controls",
        content: "Ground handling coordinates passenger, baggage, cargo, catering, cleaning, fueling, towing, and servicing. Ramp safety requires high situational awareness regarding moving aircraft, GSE, vehicles, jet blast, engine intake suction, fuel vapors, and weather. Marshalling uses standardized hand signals to guide aircraft. Refueling mandates strict fire prevention, static grounding, no ignition sources, and trained personnel. Aircraft servicing involves ground power (GPU), potable water, lavatory waste handling, and air conditioning.",
        keywords: ["ground operations", "ground handling", "ramp safety", "marshalling", "towing", "refueling safety", "aircraft servicing", "situational awareness", "ground power"],
        metadata: { section: "Ground Operations" },
      },
      {
        section_title: "7.0 Ground Support Equipment (GSE) Types & Roles",
        content: "Common GSE equipment and functions: GPU (Ground Power Unit - provides electrical power to parked aircraft), ASU (Air Start Unit - high-pressure pneumatic air to start engines), Belt Loader (conveyor moving loose baggage/cargo into holds), Pushback Tug (moves aircraft from gate/stand), Tow Tractor (tows aircraft and equipment), Catering High-Loader (elevated scissor-lift body reaching galley service doors), Passenger Boarding Stairs (mobile stairs), Potable Water Truck (sanitary drinking water servicing), Lavatory Service Truck (waste evacuation and blue chemical flushing), Baggage Tractor (tows baggage dollies), Main Deck Cargo Loader (hydraulic platform for ULD containers/pallets).",
        keywords: ["gse", "ground support equipment", "gpu", "asu", "belt loader", "pushback tug", "tow tractor", "catering high loader", "passenger stairs", "water truck", "lavatory truck", "cargo loader"],
        metadata: { section: "GSE" },
      },
      {
        section_title: "8.0 Catering Operations & Security Chain of Custody",
        content: "Catering operations involve preparing, packing, transporting, and loading inflight meals, beverages, and service carts. Security controls: Authorized catering facility -> Secure loading & sealing -> Driver identity & vehicle security verification -> Checkpoint inspection -> Ramp escort/transport -> Aircraft galley delivery. Tamper-evident seals must be verified against dispatch manifests (seal number, condition, intact verification). Any seal discrepancy (e.g. manifest seal #45821 vs observed #45827) constitutes an unauthorized access risk requiring investigation. Checkpoint handovers create immutable chain-of-custody audit logs.",
        keywords: ["catering operations", "catering security", "high lift vehicle", "food carts", "tamper evident seals", "seal discrepancies", "catering chain of custody", "catering checkpoints", "vecta icms catering"],
        metadata: { section: "Catering Operations" },
      },
      {
        section_title: "9.0 Cargo Operations & ULD Consolidation",
        content: "Cargo operations include acceptance (verification of Air Waybill, packaging, weight/dimensions, security status, and DG declarations), security screening (X-ray, ETD, physical search), consolidation into Unit Load Devices (ULD pallets and containers like AKE/LD3), hold loading per weight/balance load sheet, and secure transfers. Secure cargo status must be maintained unbroken across supply chain warehouses, vehicles, and interline transfers.",
        keywords: ["cargo operations", "cargo acceptance", "cargo screening", "secure cargo", "uld", "unit load device", "cargo manifest", "air waybill", "cargo transfer"],
        metadata: { section: "Cargo Operations" },
      },
      {
        section_title: "10.0 Dangerous Goods (DGR) & Lithium Battery Handling",
        content: "Dangerous Goods (IATA DGR / ICAO TI): 9 hazard classes (1 Explosives, 2 Gases, 3 Flammable Liquids, 4 Flammable Solids, 5 Oxidizers/Organic Peroxides, 6 Toxics/Infectious, 7 Radioactive, 8 Corrosives, 9 Miscellaneous including lithium batteries and dry ice). Lithium batteries present thermal runaway fire risks: loose batteries and power banks are CARRY-ON ONLY. Wh limits: <=100Wh allowed without operator approval; 100-160Wh requires airline approval (max 2 spares); >160Wh forbidden on passenger aircraft. Emergency response: Protect people first -> Isolate hazard -> Notify authority/DSE -> Follow emergency checklist -> Document.",
        keywords: ["dangerous goods", "dgr", "9 dg classes", "lithium batteries", "power bank", "dg labels", "un numbers", "dg storage", "dg emergency response", "un declared dg"],
        metadata: { section: "Dangerous Goods" },
      },
      {
        section_title: "11.0 Ramp Safety, FOD Prevention & Engine Hazards",
        content: "Ramp Safety hazards and controls: 1. FOD (Foreign Object Debris): Screws, bolts, plastic, luggage tags, tools causing engine or tire destruction; FOD prevention requires constant vigilance and clean ramps. 2. Engine Intake Suction: Powerful vacuum capable of ingesting personnel/equipment; danger zone distances depend on aircraft engine type and idle/takeoff thrust. 3. Jet Blast: Extreme exhaust pressure capable of overturning vehicles and projecting debris. 4. Propeller Hazards: High-speed spinning blades virtually invisible. 5. PPE: High-visibility vest, steel-toe safety footwear, hearing protection, safety glasses.",
        keywords: ["ramp safety", "fod", "foreign object debris", "jet blast", "propeller hazard", "engine intake suction", "safe approach distance", "ppe", "high vis vest", "hearing protection"],
        metadata: { section: "Ramp Safety" },
      },
      {
        section_title: "12.0 Aviation Emergency Management & Incident Escalation",
        content: "Emergency management procedures: 1. Fire: Raise alarm -> Protect life -> Isolate area -> Coordinate with Airport Fire and Rescue Services (AFRS). 2. Suspicious Item: Do NOT touch, move, or open -> Isolate area -> Evacuate immediate vicinity -> Notify Security Officer/Police. 3. Bomb Threat: Follow approved emergency checklist, notify authorities, avoid handling, follow incident command. 4. Incident Escalation Levels (conceptual framework): Level 1 (Minor operational irregularity), Level 2 (Operationally significant), Level 3 (Major safety/security breach), Level 4 (Crisis/disaster). Emergency communication: State What happened, Where, When, Who is affected, and Immediate danger.",
        keywords: ["emergency management", "aircraft emergency", "fire response", "bomb threat", "suspicious package", "unauthorized person", "medical emergency", "evacuation", "emergency communications", "incident escalation levels"],
        metadata: { section: "Emergency Management" },
      },
      {
        section_title: "13.0 Aviation Regulatory Bodies & SMS Frameworks",
        content: "International and national regulatory architecture: 1. ICAO (International Civil Aviation Organization): UN specialized agency establishing global Standards and Recommended Practices (SARPs). 2. IATA (International Air Transport Association): Airline trade association producing global operational and commercial standards (e.g. IATA DGR, Airport Handling Manual). 3. CAAM (Civil Aviation Authority of Malaysia): National regulator enforcing aviation safety, licensing, and security regulations in Malaysia. 4. FAA (US) & EASA (Europe): Major regional/national aviation authorities. 5. SMS (Safety Management System): Framework of policy, safety risk management, safety assurance, and safety promotion.",
        keywords: ["aviation regulatory bodies", "icao", "iata", "caam", "faa", "easa", "sarps", "sms", "safety management system"],
        metadata: { section: "Regulations" },
      },
      {
        section_title: "14.0 ICAO Annexes (Annex 1 to 19 Overview)",
        content: "The 19 Annexes to the Chicago Convention (ICAO): Annex 1 Personnel Licensing, Annex 2 Rules of the Air, Annex 3 Meteorological Service, Annex 4 Aeronautical Charts, Annex 5 Units of Measurement, Annex 6 Operation of Aircraft, Annex 7 Aircraft Nationality/Registration Marks, Annex 8 Airworthiness, Annex 9 Facilitation, Annex 10 Aeronautical Telecommunications, Annex 11 Air Traffic Services, Annex 12 Search and Rescue, Annex 13 Aircraft Accident/Incident Investigation, Annex 14 Aerodromes, Annex 15 Aeronautical Information Services, Annex 16 Environmental Protection, Annex 17 Aviation Security (AVSEC - safeguarding civil aviation against unlawful acts), Annex 18 Safe Transport of Dangerous Goods by Air, Annex 19 Safety Management (SMS).",
        keywords: ["icao annexes", "annex 1 to 19", "19 annexes", "annex 17", "annex 18", "annex 19", "annex 14", "annex 6", "chicago convention", "sarps"],
        metadata: { section: "ICAO Annexes" },
      },
      {
        section_title: "15.0 Aviation Terminology & Acronyms Glossary",
        content: "Comprehensive Glossary of Aviation Acronyms: ETA (Estimated Time of Arrival), ETD (Estimated Time of Departure), STD (Scheduled Time of Departure), STA (Scheduled Time of Arrival), ATC (Air Traffic Control), ATIS (Automatic Terminal Information Service), NOTAM (Notice to Airmen / Notice to Air Missions), AOC (Air Operator Certificate), AVSEC (Aviation Security), DGR (Dangerous Goods Regulations), GSE (Ground Support Equipment), FOD (Foreign Object Debris/Damage), ULD (Unit Load Device), GPU (Ground Power Unit), PPE (Personal Protective Equipment), RWY (Runway), TWY (Taxiway), APRON (Ramp/Aircraft Parking Area), AGL (Above Ground Level), AMSL (Above Mean Sea Level).",
        keywords: ["aviation glossary", "aviation acronyms", "std", "sta", "aoc", "notam", "agl", "amsl", "rwy", "twy", "apron", "gpu", "ppe", "fod meaning", "what is eta", "what is etd"],
        metadata: { section: "Terminology" },
      },
      {
        section_title: "16.0 Human Factors in Aviation Operations",
        content: "Human Factors principles: 1. Situational Awareness: 3-tier model: Perception (what is happening) -> Comprehension (understanding operational impact) -> Projection (anticipating future state). 2. Fatigue Risk: Fatigue impairs reaction time, memory, and vigilance; managed through roster rest limits and reporting. 3. Communication: Must be clear, concise, standardized, and closed-loop (read-back). 4. Error Management: Distinguishes slips, lapses, mistakes, and violations; proactive safety culture asks 'why did the system allow the error' rather than blaming individuals.",
        keywords: ["human factors", "situational awareness", "fatigue risk management", "communication", "teamwork", "decision making", "error management", "distraction", "stress", "safety culture"],
        metadata: { section: "Human Factors" },
      },
      {
        section_title: "17.0 Safety Management Systems (SMS) & Risk Assessment",
        content: "Safety Management System (SMS) fundamentals: 1. Hazard Identification: Recognizing conditions with potential to cause injury or damage. 2. Risk Assessment: Evaluating Likelihood × Severity to determine risk level. 3. Hierarchy of Controls: Elimination -> Engineering Controls -> Administrative Controls -> Training/Procedures -> PPE. 4. Safety Reporting: Reporting near-misses, hazards, and deviations without fear of punitive reprisal. 5. Root Cause Analysis: Applying '5 Whys' to uncover systemic process defects. 6. Continuous SMS Cycle: Identify -> Assess -> Control -> Monitor -> Improve.",
        keywords: ["sms", "safety management system", "hazard identification", "risk assessment", "risk matrix", "risk mitigation", "safety reporting", "corrective actions", "preventive actions", "root cause analysis"],
        metadata: { section: "Safety Management" },
      },
      {
        section_title: "18.0 Security Intelligence & Anomaly Detection (Conceptual)",
        content: "Security Intelligence & Anomaly Detection (Conceptual Reference): 1. Observable Threat Indicators: Objective behavioural cues (unauthorized access attempts, credential mismatches, route deviations, resistance to mandatory screening). 2. Access & Vehicle Anomalies: Tailgating, expired permits, zone violations, uninspected vehicles. 3. Seal & Data Discrepancies: Manifest seal numbers differing from physical seals indicate potential breach or unauthorized access. 4. Pattern Recognition & Incident Correlation: Linking recurring minor discrepancies across shifts, vehicles, or bays to identify systemic security vulnerabilities.",
        keywords: ["security intelligence", "threat identification", "suspicious behaviour", "anomaly detection", "access anomalies", "vehicle anomalies", "seal discrepancies", "documentation discrepancies", "pattern recognition", "incident correlation"],
        metadata: { section: "Security Intelligence" },
      },
      {
        section_title: "19.0 Airport Vehicles & Airside Driving Regulations",
        content: "Airport Vehicles & Airside Driving Standards: 1. Vehicle Identification: Apron permit, company livery, beacon lights, registration. 2. Driver Authorization: Valid Airside Driving Permit (ADP) and background check. 3. Airside Driving Rules: Aircraft always have absolute right-of-way; vehicles must adhere strictly to designated apron roadways and speed limits; maintain safe clearance from aircraft wings, engines, and taxiing aircraft; vehicle inspections must check cab, cargo body, undercarriage, and equipment.",
        keywords: ["airport vehicles", "vehicle identification", "authorized drivers", "vehicle permits", "vehicle inspection", "escort requirements", "airside driving rules", "airside speed limit", "aircraft right of way"],
        metadata: { section: "Airport Vehicles" },
      },
    ],
  },
  {
    id: "doc-icao-annex17",
    title: "ICAO Annex 17 — Aviation Security Knowledge Base",
    source_type: "regulatory",
    version: "2026.1",
    is_official: false,
    metadata: {
      is_official: false,
      summary_type: "icao_annex17_training_summary",
      note: "Structured training/knowledge summary of ICAO Annex 17 SARPs (Safeguarding International Civil Aviation Against Acts of Unlawful Interference) — not the verbatim/complete legal text. For exact Standard numbers, wording or compliance decisions, the authorized current edition of Annex 17 must be consulted.",
    },
    content: `# ICAO Annex 17 — Aviation Security Knowledge Base

Annex 17 to the Chicago Convention is titled "Aviation Security — Safeguarding International Civil Aviation Against Acts of Unlawful Interference." Its SARPs (Standards and Recommended Practices) establish the international framework for preventing and responding to unlawful interference with civil aviation, first adopted in 1974 and continually amended as threats evolve.

This is a structured training summary, not the complete legal text — for exact Standard numbers, wording, applicability, or compliance decisions, the authorized current edition of Annex 17 must be retrieved rather than generated from memory.

Source hierarchy for applying this knowledge: Level 1 ICAO (Annex 17 SARPs) -> Level 2 State (Malaysia's national aviation-security legislation/CAAM requirements) -> Level 3 Airport (KLIA/KUL requirements and procedures) -> Level 4 Aircraft Operator (AirAsia AOSP/SSP/company procedures) -> Level 5 Post/SOP (checkpoint, aircraft search, baggage reconciliation, access-control and incident procedures). Always answer using the most specific authorized rule applicable, and identify whether the source is ICAO, State, airport, operator, or local SOP.`,
    chunks: [
      {
        section_title: "Annex 17 Purpose & Safety vs Security Distinction",
        content: "Annex 17's purpose is to protect passengers, crew, ground personnel, airport workers, aircraft, airports/facilities, cargo and mail, civil aviation infrastructure, and the general public against acts of unlawful interference. The overriding priority is the security of passengers, crew, ground personnel and the general public. Key distinction: Safety = protection against accidental harm; Security/AVSEC = protection against intentional or unlawful acts.",
        keywords: ["annex 17 purpose", "safety vs security", "unlawful interference", "aviation security definition", "safeguarding civil aviation"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Acts of Unlawful Interference",
        content: "An act of unlawful interference is an intentional act or attempted act that threatens civil aviation security, including: unlawful seizure/hijacking of aircraft, destruction of an aircraft in service, hostage-taking on board aircraft or at aerodromes, forcible intrusion into an aircraft or airport/aviation facility, introduction of weapons or hazardous devices/material for criminal purposes, using an aircraft to cause death/serious injury/major damage, and communicating false information that endangers aircraft, passengers, crew, ground personnel or the public. Classification principle: accidental event = safety; intentional malicious/unlawful act = security; some events involve both.",
        keywords: ["acts of unlawful interference", "hijacking", "hostage taking", "forcible intrusion", "bomb threat classification", "false information threat"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Annex 17 Structure — Five Chapters",
        content: "Annex 17 is organized around: Chapter 1 Definitions, Chapter 2 General Principles, Chapter 3 Organization, Chapter 4 Preventive Security Measures, Chapter 5 Management of Response to Acts of Unlawful Interference. Chapter 4 is especially important for operational AVSEC personnel as it covers preventive controls affecting airports, aircraft, passengers, baggage, cargo, access and other aviation operations.",
        keywords: ["annex 17 structure", "annex 17 chapters", "preventive security measures chapter", "response chapter"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Annex 17 Key Definitions",
        content: "Key terms: Aviation Security — protection of civil aviation against unlawful interference through measures and human/material resources. Screening — technical/other means to identify weapons, explosives or dangerous devices/articles/substances. Security Control — means preventing introduction of weapons/explosives/dangerous devices. Security Restricted Area (SRA) — airside priority-risk areas with additional controls. Background Check — checking a person's identity, previous experience/history including permissible criminal history, to assess suitability. Unidentified Baggage — baggage without an identifiable owner/passenger. Unaccompanied Baggage — hold baggage where the passenger who checked it in is not aboard. Note: unaccompanied baggage is NOT the same as unidentified baggage.",
        keywords: ["aviation security definition", "screening definition", "security control definition", "security restricted area", "sra definition", "background check definition", "unidentified baggage", "unaccompanied baggage", "unaccompanied vs unidentified baggage"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "General Principles & Risk-Based Security",
        content: "Every Contracting State must establish measures to safeguard civil aviation against unlawful interference. Security measures should protect passengers/crew/public, be appropriate to the assessed threat, be coordinated among responsible organizations, allow rapid response when threats increase, minimize unnecessary interference with aviation operations where practicable, and be continuously reviewed and improved. Security should be risk-based rather than assuming every airport, flight, person or situation presents the same threat. Reasoning model: Threat -> Vulnerability -> Consequence -> Risk -> Mitigation. Example: insider introduces prohibited item (threat) -> weak staff access controls (vulnerability) -> unauthorized item reaches aircraft (consequence) -> risk assessment -> mitigation via access control, screening, background checks, random checks, monitoring.",
        keywords: ["risk based security", "threat vulnerability consequence risk mitigation", "security risk management", "general principles annex 17", "contracting state obligations"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "National Organization — NCASP, AOSP & SSP",
        content: "Each State establishes a National Civil Aviation Security Programme (NCASP) defining national requirements, responsibilities and measures. Responsibilities are allocated among the national authority, airport operators, aircraft operators, police, immigration, customs, security organizations, ground handlers, cargo operators, catering organizations, mail operators, and contractors/tenants — ultimate responsibility for civil aviation security rests with States. Commercial aircraft operators establish, implement and maintain an Aircraft Operator Security Programme (AOSP) meeting the State of the Operator's requirements. Where another State's requirements aren't covered by the AOSP, the operator uses Supplementary Station Procedures (SSP) — written station-specific procedures (strengthened by Amendment 18).",
        keywords: ["ncasp", "national civil aviation security programme", "aosp", "aircraft operator security programme", "ssp", "supplementary station procedures", "national organization annex 17"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Security Training & Security Culture",
        content: "Personnel performing aviation-security functions must receive training matching their duties: security awareness, access control, screening, aircraft security/search, baggage security, cargo security, incident response, recognition of suspicious behaviour/items, reporting, and emergency procedures. Personnel must demonstrate competency before independently performing security duties. Security is not solely an AVSEC officer responsibility — an effective security environment needs a positive security culture organization-wide: Observe -> Recognize -> Challenge where appropriate -> Report -> Respond. Unusual behaviour, unattended items, access violations, tampering and security weaknesses must not be ignored. Amendment 18 strengthened provisions on integrating effective security culture.",
        keywords: ["security training requirements", "security culture", "observe recognize challenge report respond", "amendment 18 security culture", "avsec training topics"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Insider Threat",
        content: "An insider exploits legitimate access, knowledge or authority — potential insiders include airport/airline employees, security personnel, ground handlers, cleaners, catering personnel, maintenance staff, contractors, vendors, and cargo personnel. Mitigation: background checks + access control + screening + supervision + random checks + security culture + reporting + information sharing + vulnerability assessment. Amendment 17 strengthened insider-threat provisions including background checks, vulnerability assessments, information sharing and screening of persons other than passengers.",
        keywords: ["insider threat", "insider threat mitigation", "amendment 17 insider threat", "persons with legitimate access risk"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Airport, Access Control & Persons Other Than Passengers",
        content: "Airports distinguish landside from airside; higher-risk airside locations may be designated Security Restricted Areas (SRA) with controlled entry. Access control ensures only authorized persons/vehicles enter controlled/restricted areas via airport ID/pass, authorization, identity verification, screening, vehicle permits, physical barriers, electronic access systems, security personnel, CCTV, and random checks. Holding a pass does not automatically mean unrestricted access everywhere — authorization must correspond to operational need (Need + Authorization + Verification = Access). Persons other than passengers (airline/airport staff, contractors, cleaners, engineers, vendors, catering personnel, ground handlers) may still present security risks and are subject to identity verification, access authorization, screening, inspection of carried articles, and random/security checks.",
        keywords: ["airside vs landside", "security restricted area sra", "access control principles", "persons other than passengers", "need authorization verification access", "staff screening"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Vehicle Security & Aircraft Security/Protection",
        content: "Vehicles entering sensitive airside areas are subject to driver authorization, vehicle permit/identity checks, purpose of entry, occupant checks, vehicle search/inspection where required, and cargo/load verification — unauthorized vehicles must not gain access. Aircraft must be protected against unauthorized interference via aircraft security checks, aircraft security searches, access control, monitoring, protection during turnaround, verification of persons accessing the aircraft, and protection following security-sensitive events. An Aircraft Security Check and an Aircraft Security Search are related but not interchangeable — the required procedure depends on applicable requirements and circumstances. Once an aircraft has received its required security control, protection must be maintained through turnaround, cleaning, catering, engineering, baggage/cargo loading, and boarding; if security integrity may have been compromised, appropriate action per applicable procedures is required.",
        keywords: ["vehicle security checks", "aircraft security check", "aircraft security search", "aircraft security check vs search", "aircraft protection during turnaround"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Passenger, Cabin Baggage, Transfer/Transit & One-Stop Security",
        content: "Originating passengers undergo required security screening before entering security restricted areas/boarding, to prevent prohibited weapons/explosives/dangerous devices from reaching an aircraft. Cabin baggage must undergo applicable security controls before entering the cabin; prohibited items found are handled per applicable national/operator procedures — not every unusual object is automatically prohibited, the determination follows applicable prohibited-items rules. Transfer and transit operations must ensure passengers/baggage without equivalent security controls cannot compromise a secure environment — related to One-Stop Security (OSS), where States may recognize equivalent security measures under appropriate arrangements.",
        keywords: ["passenger screening requirements", "cabin baggage security", "prohibited items screening", "transfer transit passenger security", "one stop security", "oss"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Hold Baggage Security & Passenger-Baggage Reconciliation",
        content: "Hold baggage must be subjected to applicable security controls (including screening capable of detecting explosives/explosive devices, strengthened by Amendment 18) before loading. Core principle: passenger boards + baggage cleared = normal carriage; passenger becomes a no-show = baggage security status must be addressed before departure per applicable requirements — this does NOT automatically mean every no-show bag must be physically removed; the exact treatment depends on whether the baggage has been appropriately identified and subjected to the security controls required for unaccompanied baggage. Correct reasoning: no-show detected -> identify associated baggage -> determine security status -> apply required security procedure -> only then permit carriage if requirements are satisfied. After screening, baggage must be protected from unauthorized interference until loaded (acceptance -> screening -> sortation -> baggage makeup -> transport -> aircraft loading); a break in security integrity may require additional action.",
        keywords: ["hold baggage security", "baggage reconciliation", "no show passenger baggage", "unaccompanied baggage procedure", "passenger baggage reconciliation", "baggage security integrity chain"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Cargo, Mail, Secure Supply Chain & Catering/Stores Security",
        content: "Cargo and mail must receive appropriate security controls before loading, achieved through physical screening or an appropriately secure supply chain — unknown/unsecured cargo and cargo from an approved secure supply chain may require different treatment. Secure supply chain concept: known origin -> controlled handling -> security controls -> protection -> transport -> loading, involving approved/regulated participants; if security integrity is lost, additional controls may be required. Catering supplies, aircraft stores, cleaning supplies, airport supplies and maintenance items entering aircraft/security-sensitive environments can create vulnerabilities and require appropriate controls to prevent introduction of prohibited items.",
        keywords: ["cargo security", "mail security", "secure supply chain", "known shipper concept", "catering security controls", "aircraft stores security"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Weapons/Dangerous Articles, Special Categories & In-Flight Security",
        content: "Annex 17 requires measures preventing unauthorized weapons, explosives and dangerous devices/articles/substances from being introduced into aircraft or security restricted environments, distinguishing unauthorized carriage from legally authorized carriage under controlled procedures (per national law and applicable operator/security procedures). Persons in custody/special categories may require prior coordination between authorities and operators on risk, escort requirements, notification, seating/security arrangements and operational precautions — operational decisions defer to applicable State/operator procedures. Security responsibilities continue in flight: protection of flight crew, communication, incident procedures, handling disruptive/security-threatening persons, and response to suspected unlawful interference — the pilot-in-command remains central to aircraft command and operational decisions.",
        keywords: ["weapons dangerous articles carriage", "persons in custody transport", "escorted prisoner transport", "in-flight security", "disruptive passenger handling", "pilot in command authority"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Cybersecurity (Standard 4.9)",
        content: "Modern aviation security includes protection of critical information and communications technology (ICT) systems and data. Annex 17 Standard 4.9.1 requires States to ensure relevant operators/entities identify critical ICT systems and data used for civil aviation purposes and implement appropriate protection based on risk assessment. Recommended Practice 4.9.2 addresses protection of confidentiality, integrity and availability, via measures such as security-by-design, supply-chain security, network separation, and protection/limitation of remote access. AVSEC is therefore not only physical security — it also covers protection against cyber-enabled unlawful interference.",
        keywords: ["aviation cybersecurity", "annex 17 standard 4.9", "ict systems protection", "confidentiality integrity availability aviation", "cyber enabled unlawful interference"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Quality Control & Corrective Action",
        content: "Security systems must be tested and monitored through audits, inspections, surveys and tests to determine whether security measures are actually implemented and remain effective — training teaches personnel, quality control checks whether requirements are being implemented effectively. When a deficiency is found: Identify -> Record -> Analyse -> Correct -> Verify -> Prevent recurrence. ICAO's security oversight framework emphasizes analysis of deficiencies, corrective recommendations, tracking rectification, and effective implementation of corrective actions.",
        keywords: ["security quality control", "security audits inspections", "corrective action process", "security deficiency handling", "security oversight framework"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Chapter 5 — Response, Contingency Planning & Suspicious Items",
        content: "States must prepare for situations where preventive measures fail or an attack is attempted, covering communication, coordination, command arrangements, emergency response, police/security involvement, airport and operator response, information management, and protection of passengers/personnel. Contingency plans should cover foreseeable incidents (hijacking, bomb threat, suspicious item, unauthorized access, hostage situation, security breach, aircraft threat, attack against facilities) — personnel should know who to contact, immediate actions, who holds command authority, and what to report; sensitive procedures are only provided to authorized personnel. Bomb threats follow established threat-assessment and response procedures — never improvise search or explosive-handling instructions. For suspicious items: DO NOT TOUCH, DO NOT MOVE, DO NOT OPEN, KEEP PEOPLE AWAY, REPORT IMMEDIATELY, then follow the airport/operator security and emergency procedure — never provide improvised explosive-disposal instructions.",
        keywords: ["chapter 5 response annex 17", "contingency planning aviation security", "bomb threat procedure", "suspicious item procedure", "do not touch do not move do not open", "security incident response plan"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Security Breach Response, Reporting & International Cooperation",
        content: "Example security breach response logic (e.g. unauthorized person enters an SRA): Detect -> prevent further unauthorized movement where safe/authorized -> notify appropriate security authority -> protect affected area -> assess security integrity -> apply required recovery measures -> document/report; exact response follows local procedures. States must report acts/attempted acts of unlawful interference to ICAO, which analyzes trends and develops improved security measures. Aviation security depends on international cooperation — sharing threat/security information, best practices, requirements, recognition of equivalent measures, assistance/training, and incident information — since a vulnerability in one part of the network can affect the wider international aviation system.",
        keywords: ["security breach response", "unauthorized area entry response", "icao incident reporting obligation", "international aviation security cooperation"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Human Factors, Layered Security & Standards vs Recommended Practices",
        content: "Technology alone cannot provide aviation security — it depends on People + Procedures + Technology + Intelligence/Information + Oversight; human factors include fatigue, distraction, complacency, communication failures, inadequate training, procedural shortcuts, and poor security culture. Layered security uses multiple sequential layers (intelligence -> background checks -> perimeter -> access control -> staff screening -> passenger screening -> baggage screening -> aircraft protection -> in-flight security) so that if one layer fails, another may still prevent an attack. Security should balance effectiveness with facilitation — proportionate to risk, avoiding unnecessary disruption to legitimate aviation activity. Terminology: a STANDARD (usually 'shall') is a specification recognized as necessary for international aviation security under the Chicago Convention framework; a RECOMMENDED PRACTICE (usually 'should') is recognized as desirable for uniform application — 'shall' must never be treated as equivalent to 'should'.",
        keywords: ["human factors aviation security", "layered security concept", "security vs facilitation", "icao standard vs recommended practice", "shall vs should icao"],
        metadata: { section: "Annex 17" },
      },
      {
        section_title: "Annex 17 vs ICAO Doc 8973 (Restricted) & Prevent-Detect-Protect-Respond-Recover-Improve",
        content: "Annex 17 defines the international aviation-security SARPs; ICAO Doc 8973 (Aviation Security Manual) provides implementation guidance supporting Annex 17 and is classified Restricted with distribution limited to authorized entities/individuals — restricted Doc 8973 content must never be reconstructed, exposed, or claimed as accessible unless legitimately supplied and the requester is authorized. Public/general questions should be answered with Annex 17 concepts and non-sensitive guidance; authorized AVSEC environments use approved internal procedures. Overall Annex 17 model: PREVENT unauthorized access and introduction of threats -> DETECT weapons/explosives/prohibited items/suspicious activity -> PROTECT passengers, aircraft, baggage, cargo, facilities and critical systems -> RESPOND to security incidents -> RECOVER security integrity after an incident/breach -> IMPROVE through audits, inspections, testing, training and corrective action.",
        keywords: ["annex 17 vs doc 8973", "icao doc 8973 restricted", "aviation security manual", "prevent detect protect respond recover improve", "restricted document handling"],
        metadata: { section: "Annex 17" },
      },
    ],
  },
];
