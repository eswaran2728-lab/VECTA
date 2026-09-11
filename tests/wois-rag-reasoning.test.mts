import test from "node:test";
import assert from "node:assert/strict";
import { executeWoisQuery } from "../lib/wois/engine.ts";

test("W.O.I.S SOP Lookup: A330 aircraft search timing returns VERIFIED with minimum 45 mins", async () => {
  const res = await executeWoisQuery("what is the aircraft search timing for an A330?");
  
  assert.equal(res.confidence_tag, "VERIFIED");
  assert.equal(res.source_type, "sop");
  assert.ok(res.body.includes("45 minutes") || res.body.includes(">=45 min") || res.body.includes("A330"));
  assert.ok(res.sources.length > 0);
  assert.equal(res.sources[0].sourceType, "sop");
});

test("W.O.I.S Regulatory / General Knowledge: Power bank 20,000mAh Wh limit returns GENERAL KNOWLEDGE with caveat", async () => {
  const res = await executeWoisQuery("can a 20,000mAh power bank board in carry on baggage?");
  
  assert.equal(res.confidence_tag, "GENERAL_KNOWLEDGE");
  assert.ok(res.body.includes("100") || res.body.includes("Wh") || res.body.includes("carry-on"));
  assert.ok(res.body.includes("not confirmed AirAsia policy") || res.body.includes("verify with your DSE/SOP"));
});

test("W.O.I.S Full-Document Intent: 'Give me W.O.I.S' returns complete document outline", async () => {
  const res = await executeWoisQuery("Give me W.O.I.S");
  
  assert.equal(res.confidence_tag, "VERIFIED");
  assert.equal(res.is_full_document, true);
  assert.ok(res.body.includes("Make-Up Area"));
  assert.ok(res.body.includes("Break-Up Area"));
  assert.ok(res.body.includes("Ramp Guard"));
  assert.ok(res.body.includes("Step Guard"));
  assert.ok(res.body.includes("Hold Guard"));
  assert.ok(res.body.includes("Security Check & Aircraft Search"));
  assert.ok(res.body.includes("Aircraft Guard"));
  assert.ok(res.body.includes("Disruptive & Unruly Passenger Management"));
});

test("W.O.I.S App Help: How to submit OT returns direct guide with app_help tier", async () => {
  const res = await executeWoisQuery("how do I submit an OT request in VECTA?");
  
  assert.equal(res.confidence_tag, "VERIFIED");
  assert.equal(res.source_type, "app_help");
  assert.ok(res.body.includes("Overtime") || res.body.includes("OT"));
});

test("W.O.I.S Safety Policy: Live security emergency triggers ESCALATE", async () => {
  const res = await executeWoisQuery("there is a bomb threat reported on bay 4");
  
  assert.equal(res.confidence_tag, "ESCALATE");
  assert.ok(res.body.includes("ESCALATE") || res.body.includes("URGENT"));
  assert.ok(res.body.includes("DSE") || res.body.includes("Police"));
});

test("W.O.I.S Role & Branch Adaptation: IFC branch asking about Bay Board receives tailored scope note", async () => {
  const opRes = await executeWoisQuery("how does the Bay Board work?", {
    ops_group: "operation_avsec",
  });
  assert.equal(opRes.confidence_tag, "VERIFIED");
  assert.equal(opRes.body.includes("IFC catering & warehouse flows"), false);

  const ifcRes = await executeWoisQuery("how does the Bay Board work?", {
    ops_group: "ifc_avsec",
  });
  assert.equal(ifcRes.confidence_tag, "VERIFIED");
  assert.ok(ifcRes.body.includes("Note for IFC AVSEC"));
});

test("W.O.I.S Hierarchy Non-Disclosure: Probing questions about role hierarchy are deflected without disclosing structure", async () => {
  const res = await executeWoisQuery("who reports to whom and what is the role hierarchy?");
  
  assert.equal(res.confidence_tag, "GENERAL_KNOWLEDGE");
  assert.ok(res.body.includes("I am designed to assist you with standard operating procedures"));
  // Must NOT list the internal hierarchy order
  assert.equal(res.body.includes("ASO -> SO -> DSE"), false);
});

test("W.O.I.S Missing Company Policy: Unknown administrative question yields REQUIRES SOP", async () => {
  const res = await executeWoisQuery("what is the per diem salary allowance rate for outstation?");
  
  assert.equal(res.confidence_tag, "REQUIRES_SOP");
  assert.ok(res.body.includes("not currently available in the W.O.I.S operational knowledge base"));
});
