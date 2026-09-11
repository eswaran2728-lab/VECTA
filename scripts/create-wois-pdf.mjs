import fs from "fs";
import path from "path";
import { jsPDF } from "jspdf";

const doc = new jsPDF({
  orientation: "portrait",
  unit: "mm",
  format: "a4",
});

const pages = [
  { page: 1, title: "W.O.I.S - World of Intelligent Aviation Systems", content: "AirAsia Aviation Security Operational Guide\nStandard Operating Procedures & Ground Duties\nVersion 2026.1" },
  { page: 2, title: "Table of Contents", content: "1. Make-Up Area (p. 3-11)\n2. Break-Up Area (p. 12-13)\n3. Ramp Guard (p. 14-15)\n4. Step Guard (p. 16-17)\n5. Hold Guard (p. 18-19)\n6. Security Check & Aircraft Search (p. 20-33)\n7. Aircraft Guard (p. 31)\n8. Patrolling - Landside (p. 34-35)\n9. Patrolling - Airside (p. 36-37)\n10. Disruptive & Unruly Passengers (p. 38-40)\n11. Case Study References (p. 41)" },
  { page: 3, title: "Make-Up Area - System Method & Cards", content: "1. Container Reconcile Card (CRC)\n2. Container Card - Every container\n3. Final Card / Delivery Card - Summary of each departure\nMake-up Domestic & International: Scanning via Baggage Reconciliation System (BRS) by ramp staff." },
  { page: 4, title: "Make-Up Area - Duties & Access Control", content: "Position at Make-Up zones as rostered.\nOnly authorized personnel at Make-Up Area.\nRecord baggage handlers name and staff number.\nPhysical check on baggage condition.\nFrisk baggage handlers after their duties.\nMonitoring baggage loaded into the right containers/trolleys with right baggage tag." },
  { page: 5, title: "Make-Up Area - Departures Security", content: "Pilferage & Sabotage Prevention:\nStaff on Duty: Name, Staff ID.\nOnly authorized personnel are allowed pass/cards authorizing physical identification.\nFrisk all personnel. Physical check. Submit all recorded details as an E-daily report." },
  { page: 6, title: "Types of Baggage - Fly-Thru / Transit & Express", content: "Fly-Thru / Transit / Transfer: Yellow Colour Tag (Continue next stop arrival).\nHi-Flyer / Express: Green Colour Tag (Fast out at arrival)." },
  { page: 7, title: "Types of Baggage - Commercial & Crew Bag", content: "Commercial / Local: White Colour Tag (Passenger baggage).\nCrew Bag: Crew Tag (Crew baggage)." },
  { page: 8, title: "Types of Baggage - Company Mail & Material", content: "Company Mail (COMAIL): Comail Label.\nCompany Material (COMAT): Comat Label." },
  { page: 9, title: "Procedures at Make-Up", content: "Check total numbers based on CRC or BRC.\nTotal checked-in baggage must equal baggage manifest.\nRULE: RIGHT BAG, RIGHT TAG, RIGHT DESTINATION.\nReconciliation at Make-up conducted by Ramp Staff." },
  { page: 10, title: "Reconciliation Procedures at Apron", content: "Baggage reconciliation and detection by Airport Security on restricted article/item.\nGuest Service to notify/call passenger.\nRamp Leader and AA AVSEC witness reconciliation at Parking Bay Hammerhead.\nConfiscated items kept under MA AVSEC custody.\nDetection of vape devices in Checked-In Baggage in significant quantities (SI MAA 01/2026): baggage offloaded with passenger owing to false declaration." },
  { page: 11, title: "Break-Up Area - Inbound Baggage", content: "Position at Break-up Area as per daily operation roster.\nOnly authorized personnel at Break-up Area.\nRecord baggage handlers name and staff number.\nEnsure each baggage with right bag tag. Physical check on baggage condition.\nFrisk baggage handlers after duties." },
  { page: 12, title: "Break-Up Area - Security & Sabotage Prevention", content: "Prevent pilferage and sabotage.\nSubmit all recorded details as an E-daily report." },
  { page: 13, title: "Ramp Guard - Airside Vicinity", content: "Ensure only authorized personnel and vehicles permitted within vicinity of aircraft.\nMonitor and enforce ground safety regulations.\nPrevent pilferage and sabotage.\nFrisk all personnel. Submit all recorded details as an E-daily report." },
  { page: 14, title: "Step Guard - Boarding Stair Security", content: "Check and frisk ground personnel, tools and equipments prior to entering and after exiting aircraft.\nMonitor boarding passengers and verify valid boarding passes.\nPrevent unauthorized tools/items from entering cabin. Submit E-daily report." },
  { page: 15, title: "Hold Guard - Cargo Hold Surveillance", content: "Observe loading and unloading activities.\nCheck Aircraft Hold: Turnaround / Long Layover (LLO) / Night Stop.\nFront Hold & Rear Hold.\nPOSITION SHALL BE AT OPPOSITE DIRECTION OF LOADING OR UNLOADING PROCESS.\nPrevent pilferage, sabotage, misroute baggage and overcarried baggage." },
  { page: 16, title: "Security Check vs Aircraft Search", content: "Aircraft Security Check: Conducted by Cabin Crew (ensure no left behind items, maintain sterility).\nAircraft Search: Conducted by AA AVSEC for Long Layover / Night Stop / Tow from Hangar.\nE-Forms: AA/SEC/F/029 REV.03 and AA/SEC/F/035 Rev.07.\nLeft Behind Item: Raise Acknowledgement Form (AA/SEC/F/007 REV.02), handover to CBTO, notify Security Officer." },
  { page: 17, title: "Internal Aircraft Check Direction", content: "Conducting security check shall be carried out internally.\nInternal check shall begin from AFT to FORWARD." },
  { page: 18, title: "Aircraft Search Minimum Timings", content: "Aircraft Search shall be conducted and completed:\n- A320 / A321: Not less than 30 mins.\n- A330: Not less than 45 mins.\nReport any irregularities detected to Security Officer / Security Executive for immediate action." },
  { page: 19, title: "Aircraft Search - Security & Sterility", content: "Prevent sabotage and stowaway.\nEnsure aircraft security and safety. Detect any prohibited items. Maintain aircraft sterile." },
  { page: 20, title: "Internal Aircraft Search Route", content: "Internal Aircraft Search must be conducted from Rear Galley (AFT) to Cockpit Area (FORWARD)." },
  { page: 21, title: "Search Area - Cockpit", content: "Cockpit panels, observer seats, emergency equipment compartments, control pedestals.\nDo not touch any active panels in the cockpit area." },
  { page: 22, title: "Search Area - Galleys", content: "All compartments, MSU, ovens, meal carts, ceiling areas and check surrounding areas." },
  { page: 23, title: "Search Area - Cabin Seats", content: "Cabin seats: between seats, under seats, chair tables, fuselage, life jacket pouches.\nCheck behind First Aid and Medical Kits (ensure unsealed condition verified)." },
  { page: 24, title: "Search Area - Lavatory", content: "Baby nappy changing table, lavatory doors, mirror compartments, walls, ceiling, floor and waste chutes." },
  { page: 25, title: "External Aircraft Search - 18 Walk-Around Points", content: "1. Left Forward Fuselage, 2. Nose, 3. Landing Gear, 4. Right Forward Fuselage, 5. Right Centre Fuselage, 6. Right Centre Wing, 7. Right Engine, 8. Right Wing Leading Edge, 9. Right Wing Tip, 10. Right Wing Trailing Edge, 11. Rear Landing Gear, 12. Right Aft Fuselage, 13. Tail & APU, 14. Left Aft Fuselage, 15. Left Wing Trailing Edge, 16. Left Wing Tip, 17. Left Wing Leading Edge, 18. Left Engine.\nDo not tamper or remove any security seals." },
  { page: 26, title: "Patrolling - Landside (Check-In & Surrounding)", content: "Attend briefing with Security Officer.\nIdentify & report: Suspicious behaviour, unattended baggage, touts/unauthorized individuals, medical emergencies, fire alarms, security breaches.\nContact Security Operation Center (SOC) to keep situation under control before SO arrival." },
  { page: 27, title: "Patrolling - Airside (Aircraft Parking Bay)", content: "Collection of all security tools/items for patrolling.\nAttend briefing with Security Officer. AA AVSEC conducts patrolling of designated areas.\nSubmit daily report at end of shift.\nMonitor surroundings, suspicious movements, and unauthorized personnel in aircraft vicinity." },
  { page: 28, title: "Disruptive vs Unruly Passengers", content: "Disruptive Passenger: Causes disturbance, arguing with Ground Staff, managed to calm passenger.\nUnruly Passenger: Violates rules, threatens safety & security.\nRULE: 'EVERY UNRULY PASSENGER IS DISRUPTIVE BUT NOT EVERY DISRUPTIVE PASSENGER IS UNRULY.'" },
  { page: 29, title: "Handling of Unruly Passengers", content: "Proceed to scene (gate/aerobridge/aircraft).\nEscort complainant and disruptive passenger to Airport Police Station together with MA SOC.\nSubmit Incident Report (HDP) within 24 hours." },
  { page: 30, title: "Handling of Potentially Disruptive Passengers", content: "Sufficient info of potential disruptive passenger (inadmissible passengers, unescorted deportees) provided to Station Manager.\nNotification to Pilot-in-Command (PIC) on duty done by Station Manager / AirAsia representative." },
];

pages.forEach((p, idx) => {
  if (idx > 0) doc.addPage();
  
  // Header
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 210, 297, "F");
  
  doc.setFont("helvetica", "bold");
  doc.setTextColor(6, 182, 212);
  doc.setFontSize(18);
  doc.text("AIRASIA AVSEC — W.O.I.S SOP MANUAL", 15, 20);
  
  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(`Page ${p.page} of 41 · Standard Operating Procedures`, 15, 28);
  
  doc.setDrawColor(6, 182, 212);
  doc.line(15, 32, 195, 32);
  
  // Title
  doc.setFont("helvetica", "bold");
  doc.setTextColor(248, 250, 252);
  doc.setFontSize(14);
  doc.text(p.title, 15, 45);
  
  // Content
  doc.setFont("helvetica", "normal");
  doc.setTextColor(226, 232, 240);
  doc.setFontSize(11);
  const splitText = doc.splitTextToSize(p.content, 180);
  doc.text(splitText, 15, 56);
  
  // Footer
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("CONFIDENTIAL — FOR INTERNAL AIRASIA AVSEC & GROUND OPERATIONS USE ONLY", 15, 285);
});

const outputDir = path.join(process.cwd(), "public", "docs");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, "W_O_I_S.pdf");
fs.writeFileSync(outputPath, Buffer.from(doc.output("arraybuffer")));
console.log("Created PDF successfully at:", outputPath);
