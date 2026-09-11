/**
 * W.O.I.S (World of Intelligent Aviation Systems) - Core Knowledge Base
 * Real PDF Ingestion & OCR Page-Attributed SOP Data, Regulatory Standards & VECTA App Guides.
 */

import type { WoisSourceType } from "@/lib/avsec/types";

export interface KnowledgeDocumentSeed {
  id: string;
  title: string;
  source_type: WoisSourceType;
  version: string;
  file_url?: string;
  content: string;
  chunks: {
    section_title: string;
    page_number?: number;
    content: string;
    keywords: string[];
    roleScope?: string[];
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

## Overtime (OT) Request & Approval
- Who can submit: ASO staff members can submit OT requests via Duty -> Overtime Request.
- Submission fields: Select Branch (Operation AVSEC, IFC AVSEC, Hub AVSEC), Date, Total Hours, and detailed Reason.
- Approval workflow: DSE (Duty Security Executive) of the matching branch reviews and approves or rejects requests. SO (Security Officer) is bypassed in the approval chain.

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
        section_title: "Overtime (OT) Request & Approval Guide",
        content: "ASO staff can submit Overtime requests under Duty -> Overtime Request. Specify Branch (Operation/IFC/Hub AVSEC), Date, Hours, and Reason. DSE of the matching branch reviews and approves or rejects the OT request. SO does not approve OT.",
        keywords: ["how to submit ot", "overtime", "submit ot", "ot request", "dse approval", "ot approval", "apply ot"],
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
    title: "International & National Aviation Security & Dangerous Goods Standards",
    source_type: "regulatory",
    version: "2026.1",
    content: `# Aviation Security & Dangerous Goods Regulatory Guidance (ICAO / IATA / CAAM)

## Dangerous Goods — Lithium Batteries & Power Banks (IATA DGR / ICAO TI)
- Power Bank Classification: Power banks, spare lithium-ion batteries, and portable electronic devices (PEDs) must be carried in CARRY-ON BAGGAGE ONLY. Strictly FORBIDDEN in checked baggage.
- Capacity Limits:
  * Up to 100 Wh (or up to 20,000 mAh at 5V / 27,000 mAh at 3.7V): Permitted in carry-on baggage without airline operator approval (standard maximum 2 spare power banks per passenger).
  * 100 Wh to 160 Wh: Permitted in carry-on baggage ONLY with prior Airline Operator Approval (maximum 2 spare batteries per passenger).
  * Exceeding 160 Wh: Strictly FORBIDDEN on passenger aircraft (cargo aircraft only with dangerous goods declaration).
- Formula for Conversion: Watt-hours (Wh) = (Milliampere-hours (mAh) * Voltage (V)) / 1000. E.g. 20,000 mAh * 3.7V / 1000 = 74 Wh (Permitted).

## Liquids, Aerosols and Gels (LAGs)
- International Flights: Individual containers must not exceed 100ml (3.4oz) capacity each, packed inside one transparent, re-sealable 1-litre plastic bag per passenger.
- Exemptions: Baby food/milk and prescription medications required during the flight (subject to security verification).

## Prohibited Articles in Cabin & Sterile Areas
- Firearms, projectile weapons, and replica firearms.
- Pointed or bladed weapons (knives, scissors with blades > 6cm from fulcrum).
- Blunt instruments capable of causing serious injury.
- Explosives, flammable substances, chemical/toxic substances.`,
    chunks: [
      {
        section_title: "Lithium Batteries & Power Bank Regulations",
        content: "Power banks must be in CARRY-ON baggage ONLY (forbidden in checked baggage). Capacity limits: <= 100 Wh (approx 20,000-27,000 mAh) permitted without operator approval; 100 Wh - 160 Wh requires airline operator approval (max 2 spares); > 160 Wh is strictly forbidden on passenger aircraft. Wh = (mAh * V) / 1000.",
        keywords: ["power bank", "lithium battery", "powerbank", "mah", "watt hour", "wh limit", "20000mah", "100wh", "160wh", "carry on", "checked baggage", "dangerous goods"],
      },
      {
        section_title: "Liquids, Aerosols & Gels (LAGs) Rules",
        content: "LAGs on international flights must be in containers <= 100ml each, fitted into one clear 1-litre resealable plastic bag. Exemptions apply for baby formula and essential personal medications.",
        keywords: ["lags", "liquids", "gels", "aerosols", "100ml", "plastic bag", "water bottle"],
      },
      {
        section_title: "Prohibited Articles in Cabin",
        content: "Blades/scissors > 6cm, firearms, toy replicas, blunt weapons, explosives, flammables, and disabling sprays are strictly prohibited in the passenger cabin and sterile airside zones.",
        keywords: ["prohibited items", "weapons", "knives", "scissors", "blades", "firearms"],
      },
    ],
  },
];
