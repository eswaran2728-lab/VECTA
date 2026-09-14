import test from "node:test";
import assert from "node:assert/strict";
import { sec016Schema } from "../lib/avsec/schemas/sec016.ts";
import { hoursSince } from "../lib/avsec/datetime.ts";

test("SEC016 schema: validates arrival flight_type by default", () => {
  const parsed = sec016Schema.safeParse({
    station: "KUL",
    team: "A",
    staff_name: "John Doe",
    staff_no: "12345",
    duty_date: "2026-09-11",
    duty_hour: "08:00",
    flight: "AK123",
    origin_arr_dep: "KUL",
    assisted_by: "Jane",
    aircraft_type: "A 320",
    reg_no: "9M-AGY",
    bay_no: "B12",
    sta_std: "10:00",
    ata_atd: "10:05",
    do_infmd: "NO",
    inbound_baggage: "100",
    inbound_cargo: "50",
    inbound_co_mail: "0",
    shift_leader: "Leader 1",
    ramp_agents_baggage: "John Doe A1234 (hold)",
    ramp_agents_cargo: "Jane Roe A5678 (hold)",
    cargo_hold_checked: "YES",
    staff_frisked: "YES",
    discrepancies: "N/A",
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.flight_type, "arrival");
    assert.equal(parsed.data.aircraft_search_completed, false);
  }
});

test("SEC016 schema: accepts departure flight_type and search completion status", () => {
  const parsed = sec016Schema.safeParse({
    station: "KUL",
    team: "A",
    staff_name: "John Doe",
    staff_no: "12345",
    duty_date: "2026-09-11",
    duty_hour: "08:00",
    flight: "AK123",
    origin_arr_dep: "KUL",
    assisted_by: "Jane",
    aircraft_type: "A 320",
    reg_no: "9M-AGY",
    bay_no: "B12",
    sta_std: "10:00",
    ata_atd: "10:05",
    do_infmd: "NO",
    outbound_baggage: "120",
    outbound_cargo: "60",
    outbound_co_mail: "0",
    shift_leader: "Leader 1",
    ramp_agents_baggage: "John Doe A1234 (hold)",
    ramp_agents_cargo: "Jane Roe A5678 (hold)",
    cargo_hold_checked: "YES",
    staff_frisked: "YES",
    discrepancies: "N/A",
    offload_baggage_tag_no: "BAG001",
    offload_remark: "None",
    flight_type: "departure",
    aircraft_search_completed: true,
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.flight_type, "departure");
    assert.equal(parsed.data.aircraft_search_completed, true);
  }
});

test("SEC016 schema: rejects invalid flight_type", () => {
  const parsed = sec016Schema.safeParse({
    station: "KUL",
    team: "A",
    staff_name: "John Doe",
    staff_no: "12345",
    duty_date: "2026-09-11",
    duty_hour: "0800 - 1600",
    flight: "AK123",
    origin_arr_dep: "KUL",
    assisted_by: "Jane",
    aircraft_type: "A320",
    reg_no: "9M-AGY",
    bay_no: "B12",
    sta_std: "1000",
    ata_atd: "1005",
    shift_leader: "Leader 1",
    ramp_staff_1: "Ramp 1",
    flight_type: "transit", // invalid
  });

  assert.equal(parsed.success, false);
});

test("4-hour aircraft search rule calculation: correctly identifies overdue ground time", () => {
  const now = new Date();
  const fiveHoursAgo = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();

  assert.ok(hoursSince(fiveHoursAgo) >= 4, "5 hours ago should exceed 4-hour threshold");
  assert.ok(hoursSince(twoHoursAgo) < 4, "2 hours ago should be below 4-hour threshold");
});

test("4-hour aircraft search rule: soft flag logic", () => {
  // Simulate soft rule check:
  // When ground hours >= 4 and aircraft_search_completed is false:
  const checkOverdue = (hoursOnGround: number, searchCompleted: boolean) => {
    let searchOverdueFlag = false;
    let searchRemark: string | null = null;
    let discrepancies = "";

    if (hoursOnGround >= 4 && !searchCompleted) {
      searchOverdueFlag = true;
      searchRemark = "Aircraft Search not completed — aircraft on ground >4h";
      discrepancies = "[AUTO-FLAG] " + searchRemark;
    }
    return { searchOverdueFlag, searchRemark, discrepancies };
  };

  const overdueWithoutSearch = checkOverdue(4.5, false);
  assert.equal(overdueWithoutSearch.searchOverdueFlag, true);
  assert.equal(overdueWithoutSearch.searchRemark, "Aircraft Search not completed — aircraft on ground >4h");
  assert.ok(overdueWithoutSearch.discrepancies.includes("[AUTO-FLAG]"));

  const overdueWithSearch = checkOverdue(4.5, true);
  assert.equal(overdueWithSearch.searchOverdueFlag, false);
  assert.equal(overdueWithSearch.searchRemark, null);

  const normalTimeWithoutSearch = checkOverdue(2.1, false);
  assert.equal(normalTimeWithoutSearch.searchOverdueFlag, false);
  assert.equal(normalTimeWithoutSearch.searchRemark, null);
});
