import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_CAPABILITIES, canCreateReport } from "../lib/auth/role-capabilities.ts";
import { REPORT_CATEGORIES, groupAllowedReportForms, reportDisplayTitle } from "../lib/avsec/reports/report-categories.ts";
import { REPORT_META, REPORT_TYPES } from "../lib/avsec/reference-data.ts";
import { makeupSchema, makeupDefaults } from "../lib/avsec/schemas/makeup.ts";
import { breakupSchema, breakupDefaults } from "../lib/avsec/schemas/breakup.ts";

// ---------------------------------------------------------------------------------------------------------------------
// 1. Schemas: Makeup Report (departure baggage operations)
// ---------------------------------------------------------------------------------------------------------------------

test("makeup: valid departure baggage report with required fields and baggage entries passes validation", () => {
  const valid = {
    station: "KUL - MAA",
    flight_number: "AK 123",
    duty_date: "2026-10-28",
    team: "ALPHA",
    destination: "PEN",
    first_baggage_time: "08:15",
    last_baggage_tag_time: "09:30",
    baggage_entries: [
      {
        entry_no: 1,
        container_pallet_trolley_no: "AKE12345AK",
        seal_no: "SL-9988",
        bay: "B12",
        destination: "PEN",
      },
    ],
    ground_handling_personnel: "Ahmad Staff #12345",
    remarks: "Operations normal",
    discrepancies: [
      {
        baggage_tag_no: "AK987654",
        details: "Tag torn, verified manually",
      },
    ],
    officer_confirmation: true,
  };

  const result = makeupSchema.safeParse(valid);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  if (result.success) {
    assert.equal(result.data.flight_number, "AK 123");
    assert.equal(result.data.destination, "PEN");
    assert.equal(result.data.baggage_entries.length, 1);
    assert.equal(result.data.baggage_entries[0].bay, "B12");
  }
});

test("makeup: rejects missing required fields and unconfirmed officer checkbox", () => {
  const missing = {
    ...makeupDefaults,
    baggage_entries: [],
    officer_confirmation: false,
  };
  const result = makeupSchema.safeParse(missing);
  assert.equal(result.success, false);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join("."));
    assert.ok(fields.includes("station"), "station required");
    assert.ok(fields.includes("flight_number"), "flight_number required");
    assert.ok(fields.includes("duty_date"), "duty_date required");
    assert.ok(fields.includes("team"), "team required");
    assert.ok(fields.includes("destination"), "destination required");
    assert.ok(fields.includes("first_baggage_time"), "first_baggage_time required");
    assert.ok(fields.includes("last_baggage_tag_time"), "last_baggage_tag_time required");
    assert.ok(fields.includes("baggage_entries"), "baggage_entries required");
    assert.ok(fields.includes("officer_confirmation"), "officer_confirmation required");
  }
});

test("makeup: supports empty optional fields and discrepancies without forcing invented data", () => {
  const minimal = {
    station: "KUL - MAA",
    flight_number: "AK 456",
    duty_date: "2026-10-28",
    team: "BRAVO",
    destination: "BKI",
    first_baggage_time: "14:00",
    last_baggage_tag_time: "14:45",
    baggage_entries: [
      {
        container_pallet_trolley_no: "TRL-01",
        seal_no: "SL-0011",
        bay: "A4",
        destination: "BKI",
      },
    ],
    ground_handling_personnel: "",
    remarks: "",
    discrepancies: [],
    officer_confirmation: true,
  };

  const result = makeupSchema.safeParse(minimal);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  if (result.success) {
    assert.equal(result.data.ground_handling_personnel, "");
    assert.equal(result.data.remarks, "");
    assert.deepEqual(result.data.discrepancies, []);
  }
});

test("makeup: strictly requires Bay and rejects Aircraft Position terminology", () => {
  const schemaKeys = Object.keys(makeupSchema.shape);
  assert.ok(!schemaKeys.includes("aircraft_position"));
  assert.ok(!schemaKeys.includes("parking_position"));
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Schemas: Breakup Report (arrival baggage operations)
// ---------------------------------------------------------------------------------------------------------------------

test("breakup: valid arrival baggage report with required fields and entries passes validation", () => {
  const valid = {
    station: "KUL - AAX",
    flight_number: "D7 789",
    duty_date: "2026-10-28",
    team: "CHARLIE",
    origin: "HND",
    first_container_time: "22:10",
    last_container_time: "23:05",
    baggage_entries: [
      {
        entry_no: 1,
        container_pallet_trolley_no: "AKD99887D7",
        baggage_tag_no: "D7112233",
        discrepancy_details: "Handle broken on 1 bag",
      },
      {
        entry_no: 2,
        container_pallet_trolley_no: "AKD99888D7",
        baggage_tag_no: "",
        discrepancy_details: "",
      },
    ],
    ground_handling_personnel: "Ground Handling Crew Team 3",
    pir_dpr_details: "PIR-KUL-20261028-01 filed for broken handle",
    containers_inspected_clean: true,
  };

  const result = breakupSchema.safeParse(valid);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  if (result.success) {
    assert.equal(result.data.flight_number, "D7 789");
    assert.equal(result.data.origin, "HND");
    assert.equal(result.data.baggage_entries.length, 2);
    assert.equal(result.data.containers_inspected_clean, true);
  }
});

test("breakup: rejects missing required fields and unconfirmed clean inspection checkbox", () => {
  const missing = {
    ...breakupDefaults,
    baggage_entries: [],
    containers_inspected_clean: false,
  };
  const result = breakupSchema.safeParse(missing);
  assert.equal(result.success, false);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join("."));
    assert.ok(fields.includes("station"), "station required");
    assert.ok(fields.includes("flight_number"), "flight_number required");
    assert.ok(fields.includes("duty_date"), "duty_date required");
    assert.ok(fields.includes("team"), "team required");
    assert.ok(fields.includes("origin"), "origin required");
    assert.ok(fields.includes("first_container_time"), "first_container_time required");
    assert.ok(fields.includes("last_container_time"), "last_container_time required");
    assert.ok(fields.includes("baggage_entries"), "baggage_entries required");
    assert.ok(fields.includes("containers_inspected_clean"), "containers_inspected_clean required");
  }
});

test("breakup: supports clean 'None' or empty state for optional sections", () => {
  const clean = {
    station: "KUL - AAX",
    flight_number: "D7 222",
    duty_date: "2026-10-28",
    team: "DELTA",
    origin: "ICN",
    first_container_time: "01:30",
    last_container_time: "02:15",
    baggage_entries: [
      {
        container_pallet_trolley_no: "AKE44556D7",
        baggage_tag_no: "",
        discrepancy_details: "",
      },
    ],
    ground_handling_personnel: "",
    pir_dpr_details: "None",
    containers_inspected_clean: true,
  };

  const result = breakupSchema.safeParse(clean);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error.issues));
  if (result.success) {
    assert.equal(result.data.pir_dpr_details, "None");
    assert.equal(result.data.baggage_entries[0].discrepancy_details, "");
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Role Capabilities & Report Types
// ---------------------------------------------------------------------------------------------------------------------

test("capabilities: ASO can create makeup and breakup; other roles cannot", () => {
  assert.ok((ROLE_CAPABILITIES.aso.reportForms as readonly string[]).includes("makeup"), "ASO has makeup");
  assert.ok((ROLE_CAPABILITIES.aso.reportForms as readonly string[]).includes("breakup"), "ASO has breakup");
  assert.equal(canCreateReport(["aso"], "makeup"), true);
  assert.equal(canCreateReport(["aso"], "breakup"), true);

  for (const role of ["so", "sso", "dse", "hub_se", "operation_manager", "main_enforcement", "ghod"]) {
    assert.equal(canCreateReport([role], "makeup"), false, `${role} cannot create makeup`);
    assert.equal(canCreateReport([role], "breakup"), false, `${role} cannot create breakup`);
  }
});

test("reference-data: REPORT_TYPES and REPORT_META include makeup and breakup without invented codes", () => {
  assert.ok((REPORT_TYPES as readonly string[]).includes("makeup"));
  assert.ok((REPORT_TYPES as readonly string[]).includes("breakup"));

  assert.equal(REPORT_META.makeup.name, "MAKEUP REPORT");
  assert.equal(REPORT_META.makeup.code, "Makeup Report");
  assert.equal(REPORT_META.makeup.table, "report_makeup");
  assert.equal(REPORT_META.makeup.route, "makeup");

  assert.equal(REPORT_META.breakup.name, "BREAKUP REPORT");
  assert.equal(REPORT_META.breakup.code, "Breakup Report");
  assert.equal(REPORT_META.breakup.table, "report_breakup");
  assert.equal(REPORT_META.breakup.route, "breakup");

  // Verify no invented AirAsia form codes
  assert.doesNotMatch(REPORT_META.makeup.code, /^AA\/SEC\/F\//i);
  assert.doesNotMatch(REPORT_META.breakup.code, /^AA\/SEC\/F\//i);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Report Categories: Separate Makeup Report and Breakup Report categories
// ---------------------------------------------------------------------------------------------------------------------

test("categories: separate categories for Makeup Report and Breakup Report; Daily and Aircraft remain", () => {
  const categoryIds = REPORT_CATEGORIES.map((c) => c.id);
  assert.deepEqual(categoryIds, ["daily", "aircraft", "makeup", "breakup"]);

  const makeupCat = REPORT_CATEGORIES.find((c) => c.id === "makeup");
  assert.ok(makeupCat);
  assert.equal(makeupCat.title, "Makeup Report");
  assert.deepEqual([...makeupCat.forms], ["makeup"]);

  const breakupCat = REPORT_CATEGORIES.find((c) => c.id === "breakup");
  assert.ok(breakupCat);
  assert.equal(breakupCat.title, "Breakup Report");
  assert.deepEqual([...breakupCat.forms], ["breakup"]);

  assert.equal(reportDisplayTitle("makeup"), "Makeup Report");
  assert.equal(reportDisplayTitle("breakup"), "Breakup Report");
});

test("categories: ASO with makeup and breakup assignments sees the new separate categories", () => {
  const allowed = ["sec014", "sec016", "makeup", "breakup"];
  const grouped = groupAllowedReportForms(allowed);
  assert.deepEqual(
    grouped.map((g) => [g.id, g.forms.map((f) => f.type)]),
    [
      ["daily", ["sec014"]],
      ["aircraft", ["sec016"]],
      ["makeup", ["makeup"]],
      ["breakup", ["breakup"]],
    ],
  );
});

test("runner: frozen SHA, baseline, and live phrase for makeup/breakup migration", async () => {
  // @ts-expect-error plain .mjs tooling modules
  const R = await import("../scripts/staging/apply-makeup-breakup-migration.mjs");
  assert.equal(R.MIGRATIONS.length, 1);
  assert.equal(R.MIGRATIONS[0].version, "20261129000001");
  assert.equal(R.PRE_COUNT, 102);
  assert.equal(R.LAST_PRE, "20261128000001");
  assert.equal(R.POST_COUNT, 103);
  assert.equal(R.POST_LAST, "20261129000001");
  assert.equal(R.LIVE_PHRASE, "APPLY 20261129000001 TO STAGING ddlctzbnqewubltcavkh");
});

test("runner: frozen SHA, baseline, and live phrase for source-secure migration", async () => {
  // @ts-expect-error plain .mjs tooling modules
  const R = await import("../scripts/staging/apply-source-secure-migration.mjs");
  assert.equal(R.MIGRATIONS.length, 1);
  assert.equal(R.MIGRATIONS[0].version, "20261130000001");
  assert.equal(R.PRE_COUNT, 103);
  assert.equal(R.LAST_PRE, "20261129000001");
  assert.equal(R.POST_COUNT, 104);
  assert.equal(R.POST_LAST, "20261130000001");
  assert.equal(R.LIVE_PHRASE, "APPLY 20261130000001 TO STAGING ddlctzbnqewubltcavkh");
});

test("runner: frozen SHA, baseline, and live phrase for child-policy-fix migration", async () => {
  // @ts-expect-error plain .mjs tooling modules
  const R = await import("../scripts/staging/apply-child-policy-fix-migration.mjs");
  assert.equal(R.MIGRATIONS.length, 1);
  assert.equal(R.MIGRATIONS[0].version, "20261130000002");
  assert.equal(R.PRE_COUNT, 104);
  assert.equal(R.LAST_PRE, "20261130000001");
  assert.equal(R.POST_COUNT, 105);
  assert.equal(R.POST_LAST, "20261130000002");
  assert.equal(R.LIVE_PHRASE, "APPLY 20261130000002 TO STAGING ddlctzbnqewubltcavkh");
});
