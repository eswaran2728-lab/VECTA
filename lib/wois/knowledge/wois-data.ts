/**
 * W.O.I.S (World of Intelligent Aviation Systems) - Core Knowledge Base
 * Pre-compiled, high-fidelity operational SOPs, Regulatory Standards & VECTA App Guides.
 */

import type { WoisSourceType } from "@/lib/avsec/types";

export interface KnowledgeDocumentSeed {
  id: string;
  title: string;
  source_type: WoisSourceType;
  version: string;
  content: string;
  chunks: {
    section_title: string;
    content: string;
    keywords: string[];
    roleScope?: string[]; // If specific to operation or ifc
  }[];
}

export const WOIS_KNOWLEDGE_DOCUMENTS: KnowledgeDocumentSeed[] = [
  {
    id: "doc-wois-sop-manual",
    title: "AirAsia AVSEC W.O.I.S Standard Operating Procedures (SOP) Manual",
    source_type: "sop",
    version: "2026.1",
    content: `# AirAsia AVSEC W.O.I.S Standard Operating Procedures (SOP) Manual

## 1. Make-Up Area (BMA) Security
The Baggage Make-Up Area (BMA) is a designated security-restricted zone where outbound checked baggage is sorted, screened, containerized, and loaded onto baggage carts/ULDs for transport to the aircraft.
- Access Control: Only authorized personnel displaying valid Airport Security Passes with BMA endorsement are permitted entry.
- 100% Screening Verification: All baggage arriving from the Check-In conveyors must pass through the Hold Baggage Screening (HBS) system before being placed on make-up carousels or loaded into ULDs/carts.
- Reconciliation (BRS): Staff must verify that every loaded bag is reconciled with a boarded passenger via the Baggage Reconciliation System (BRS). Unaccompanied baggage must not be loaded unless authorized under strict rush/unaccompanied baggage procedures.
- Tamper-Evident Security: ULDs and baggage carts must be kept under constant surveillance or sealed with numbered tamper-evident seals before apron transport.

## 2. Break-Up Area (BBA) Security
The Baggage Break-Up Area (BBA) handles inbound baggage offloaded from arriving flights for delivery to passenger claim carousels.
- Supervision: AVSEC personnel must supervise the offloading process from carts/ULDs onto the arrival conveyor belt.
- Transit/Transfer Baggage Segregation: Transfer baggage must be isolated immediately and routed to the transfer screening facility without entering landside circulation.
- Unclaimed or Suspicious Items: Any damaged, leaking, unmanifested, or suspicious baggage must be isolated immediately and reported to the Duty Security Executive (DSE) and Enforcement.

## 3. Ramp Guard & Apron Security
Ramp Guards provide active physical security surveillance around the aircraft footprint during turnaround and ground servicing.
- Safety Zone Demarcation: Maintain a secure perimeter around the aircraft, engines, cargo compartments, and ground service equipment (GSE).
- Foreign Object Debris (FOD) Prevention: Inspect the parking bay surface prior to aircraft arrival and prior to pushback for any debris.
- Access Verification: Challenge every individual approaching the aircraft. Ensure all service providers (catering, fueling, engineering, cleaning) display valid airport passes and task-specific authorizations.
- Catering & Fuel Access: Verify that catering truck shutters and locks are inspected before docking with the aircraft galley doors.

## 4. Step Guard & Boarding Security
Step Guards manage physical security at all aircraft boarding stairs and passenger loading bridges (aerobridges).
- Boarding Control: Position at the foot or top of boarding steps to verify that every boarding passenger possesses a valid boarding pass for the specific flight and date.
- Headcount & Hand Baggage: Monitor passenger flow to prevent congestion, enforce hand luggage limits, and ensure passengers do not access the apron without authorization.
- Sterile Path: Ensure no unauthorized individuals bypass the gate security checkpoint or enter the aircraft cabin un-screened.

## 5. Hold Guard & Cargo Security
Hold Guards are stationed at forward, aft, and bulk cargo hold compartments during all loading and unloading operations.
- Surveillance: Maintain continuous line of sight into cargo compartments.
- Tail-Tipping Prevention: Ensure loading complies with load sheet sequences to prevent aircraft tail tipping hazards during aft cargo handling.
- Bulk & ULD Loading: Verify that all loaded cargo, mail, and baggage match the flight manifest and show no signs of tampering, punctures, or chemical leakage.

## 6. Security Check & Aircraft Search Procedures
Aircraft security checks and searches are mandatory protocols designed to detect prohibited items, weapons, explosives, or unauthorized persons on board.
- Minimum Aircraft Search Timings:
  * Airbus A320: Minimum 30 minutes.
  * Airbus A321: Minimum 35 minutes.
  * Airbus A330: Minimum 45 minutes.
- When Required:
  * Originating flights / First departure of the day.
  * Inbound international flights transitioning to domestic routes.
  * Transit flights where passengers have disembarked.
  * Any flight following a security alert, breach, or threat.
  * Aircraft that have remained unattended on ground for more than 4 hours (4-Hour Search Rule).
- Systematic Search Zones:
  1. Flight Deck: Observer seats, control pedestal, emergency equipment, circuit breaker panels.
  2. Cabin: Overhead stowage compartments, seat pockets, under-seat spaces, life jacket pouches, tray tables.
  3. Galleys: Waste bins, meal carts, oven compartments, ceiling panels, trolley bays.
  4. Lavatories: Under-sink waste chutes, toilet shroud panels, baby changing tables, ceiling hatches.
  5. Cargo Holds: Forward, aft, and bulk cargo compartments, floor tracks, sidewall panels.
- Security Seals: Upon completing the search, all external access panels, catering carts, and cabin doors must be sealed with tamper-evident serial-numbered seals if the aircraft remains unattended.

## 7. Aircraft Guard & Unattended Aircraft
- Unattended Aircraft: Any aircraft parked at remote bays or hangars without active flight/cabin crew must be guarded by AVSEC personnel or sealed with authorized tamper-evident security seals.
- Seal Verification: Before flight crew arrival, AVSEC staff must inspect all applied seals against the seal log (SEC 016 / SEC 029) to ensure no seal is broken or tampered with.
- Handover Protocol: Formal security handover must be conducted with the Captain (Pilot-in-Command) or Lead Flight Attendant before passenger boarding.

## 8. Landside & Airside Patrolling
- Sterile Area Surveillance: Conduct continuous roving patrols of boarding gate lounges, screening checkpoints, transfer corridors, and baggage sorting areas.
- Challenge Procedure: Politely but firmly challenge any individual found without visible identification, attempting to access restricted doors, or exhibiting suspicious profiling indicators.
- Vulnerability Checks: Inspect emergency exits, perimeter fences, and security doors for proper locking and alarm operation.

## 9. Disruptive & Unruly Passenger Management
AirAsia AVSEC classifies unruly passenger incidents according to standard ICAO/IATA levels:
- Level 1 (Disruptive Behaviour - Verbal): Profanity, verbal harassment, refusal to comply with safety instructions (e.g. seatbelts, smoking, electronic devices). Action: Clear verbal warning by Cabin Crew/Gate Staff, de-escalation techniques.
- Level 2 (Physically Abusive Behaviour): Pushing, shoving, grabbing, damaging cabin property, obstructing crew. Action: Issue Final Written Warning; AVSEC Ramp/Gate standby requested on arrival.
- Level 3 (Life-Threatening Behaviour): Display of weapon, physical assault, credible threats of murder/bomb, intent to cause bodily harm. Action: Restraint kit authorized by Pilot-in-Command (PIC); immediate AVSEC and Police arrest upon touchdown.
- Level 4 (Attempted or Actual Flight Deck Breach): Forcible attempt to enter cockpit, hijacking threat. Action: Maximum physical defense, restraint, immediate emergency landing and law enforcement intervention.
- Escalation & Documentation: For all Level 2+ incidents, submit SEC 014 Incident Report and inform DSE/Enforcement immediately.

## 10. SEC Series Report Architecture
- SEC 013: Profiling & Gate Surveillance Log.
- SEC 014: AVSEC Daily Attendance, Logsheet & Incident Report.
- SEC 016: Aircraft Attendance Report (Arrival vs Departure flight type, Bay Board auto-link).
- SEC 018: Security Equipment Daily Checklist.
- SEC 029: Aircraft Security Search Inspection & Seal Record.
- SEC 033: Hold Baggage Screening / Cargo Security Record.`,
    chunks: [
      {
        section_title: "Make-Up Area (BMA) Security",
        content: "Baggage Make-Up Area (BMA) is a security-restricted zone where outbound baggage is sorted, 100% screened via HBS, and loaded into ULDs/carts. Reconciliation with boarded passengers via BRS is mandatory. Tamper-evident seals must be used on baggage carts during apron transport.",
        keywords: ["bma", "make-up area", "makeup area", "baggage make up", "screening", "brs", "reconciliation", "baggage cart"],
      },
      {
        section_title: "Break-Up Area (BBA) Security",
        content: "Baggage Break-Up Area (BBA) handles inbound baggage offloading. AVSEC supervises offloading onto claim carousels. Transfer/transit baggage is segregated for transfer screening. Damaged, unmanifested, or suspicious bags must be isolated and reported to DSE/Enforcement.",
        keywords: ["bba", "break-up area", "breakup area", "inbound baggage", "transfer baggage", "transit bags", "suspicious bag"],
      },
      {
        section_title: "Ramp Guard & Apron Security",
        content: "Ramp Guards maintain physical security around the aircraft footprint. Enforces access control by challenging all service personnel (catering, fueling, engineering). Conducts Foreign Object Debris (FOD) checks of the parking bay surface prior to arrival and pushback.",
        keywords: ["ramp guard", "apron", "ramp security", "fod", "foreign object debris", "catering truck", "fueling", "footprint"],
      },
      {
        section_title: "Step Guard & Boarding Security",
        content: "Step Guards supervise passenger boarding at aircraft stairs and aerobridges. Verifies valid boarding passes for the specific flight and date. Ensures sterile path from boarding gate to aircraft cabin and prevents un-screened passenger entry.",
        keywords: ["step guard", "boarding", "stairs", "aerobridge", "boarding pass", "passenger boarding", "sterile path"],
      },
      {
        section_title: "Hold Guard & Cargo Compartment Security",
        content: "Hold Guards supervise cargo and baggage loading/unloading into forward, aft, and bulk cargo compartments. Maintains continuous line of sight into holds, enforces tail-tipping prevention sequences, and verifies cargo matches flight manifests.",
        keywords: ["hold guard", "cargo hold", "bulk hold", "tail tipping", "uld", "loading sequence", "baggage hold"],
      },
      {
        section_title: "Security Check & Aircraft Search Procedures & Timings",
        content: "Minimum Aircraft Search Timings: Airbus A320 = minimum 30 minutes; Airbus A321 = minimum 35 minutes; Airbus A330 = minimum 45 minutes. Mandatory for first flight of day, international to domestic transitions, transit flights, security threats, or when unattended > 4 hours (4-Hour Search Rule). Search zones include flight deck, cabin overhead bins/seats, galleys, lavatories, and cargo holds.",
        keywords: ["search timing", "aircraft search", "a320", "a321", "a330", "search time", "45 mins", "30 mins", "35 mins", "4-hour search", "security search", "aircraft search checklist"],
      },
      {
        section_title: "Aircraft Guard & Unattended Aircraft",
        content: "Unattended aircraft at remote bays/hangars must be guarded by AVSEC or sealed with tamper-evident serial-numbered seals. AVSEC inspects seals against SEC 016/029 logs prior to flight crew arrival and conducts formal security handover with Pilot-in-Command (PIC).",
        keywords: ["aircraft guard", "unattended aircraft", "security seals", "tamper evident", "handover", "seal verification", "pic"],
      },
      {
        section_title: "Disruptive & Unruly Passenger Handling Levels",
        content: "Level 1: Verbal disobedience/profanity -> Verbal warning and de-escalation. Level 2: Physical non-violent abuse/obstruction -> Final written warning, AVSEC standby on arrival. Level 3: Life-threatening behaviour/assault/weapons -> Restraint kit authorized by PIC, police arrest on touchdown. Level 4: Attempted/actual flight deck breach -> Maximum physical defense, immediate emergency landing and law enforcement intervention. Submit SEC 014 report.",
        keywords: ["unruly passenger", "disruptive passenger", "passenger level", "level 1", "level 2", "level 3", "level 4", "restraint kit", "flight deck breach", "violence"],
      },
      {
        section_title: "SEC Series Report Types Summary",
        content: "SEC 013: Profiling & Gate Surveillance. SEC 014: AVSEC Daily Attendance & Incident Report. SEC 016: Aircraft Attendance Report (Arrival/Departure, Bay Board auto-link). SEC 018: Security Equipment Daily Checklist. SEC 029: Aircraft Security Search Inspection & Seal Record. SEC 033: Hold Baggage Screening Record. Offload: Baggage Offload Record.",
        keywords: ["sec013", "sec014", "sec016", "sec018", "sec029", "sec033", "offload", "reports", "sec forms"],
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
- 4-Hour Aircraft Search Rule: If an aircraft remains on the ground for $\ge$ 4 hours between arrival and departure, VECTA displays an amber warning requiring a mandatory full aircraft security search (SEC 029).

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
