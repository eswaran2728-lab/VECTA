import { z } from "zod";
import { requiredText, timeString, dateString, yesNo } from "./common";
import { SEC016_CHECKED_OPTIONS } from "../reference-data";

export const sec016Schema = z
  .object({
    // staff details
    station: requiredText("Station"),
    team: requiredText("Team"),
    staff_name: requiredText("Name"),
    staff_no: requiredText("Staff No"),
    duty_date: dateString("Duty date"),
    duty_hour: timeString("Duty hour"),

    // aircraft
    flight: requiredText("Flight"),
    origin_arr_dep: requiredText("Origin Arr / Dep"),
    assisted_by: requiredText("Assisted By"),
    aircraft_type: z.enum(["A 320", "A 321", "A 330", "Other"]),
    aircraft_type_other: z.string().trim().optional().default(""),
    reg_no: requiredText("Reg No"),
    sta_std: timeString("STA / STD"),
    ata_atd: timeString("ATA / ATD"),
    bay_no: requiredText("Bay No"),
    reason_for_delay: z.string().trim().optional().default(""),
    do_infmd: yesNo,
    inbound_baggage: requiredText("Inbound Baggage"),
    outbound_baggage: requiredText("Outbound Baggage"),
    inbound_cargo: requiredText("Inbound Cargo"),
    outbound_cargo: requiredText("Outbound Cargo"),
    inbound_co_mail: requiredText("Inbound Co-Mail / Comart"),
    outbound_co_mail: requiredText("Outbound Co-Mail / Comart"),
    checked_items: z
      .array(z.enum(SEC016_CHECKED_OPTIONS))
      .min(1, "Select at least one CHECKED item"),
    shift_leader: requiredText("Shift Leader"),
    ramp_staff_1: requiredText("Ramp Staff (Handler 1)"),
    ramp_staff_2: requiredText("Ramp Staff (Handler 2)"),
    ramp_staff_3: requiredText("Ramp Staff (Handler 3)"),
    ramp_staff_4: requiredText("Ramp Staff (Handler 4)"),
    ramp_staff_5: requiredText("Ramp Staff (Handler 5)"),
    cargo_hold_checked: yesNo,
    staff_frisked: yesNo,
    discrepancies: requiredText("Discrepancies (if any)").or(z.literal("N/A")),

    // offload
    offload_flight_no: requiredText("Offload Flight No"),
    offload_destination: requiredText("Destination"),
    offload_baggage_tag_no: requiredText("Baggage Tag No"),
    offload_total_baggage: requiredText("Total Baggage"),
    offload_remark: requiredText("Remark"),
  })
  .superRefine((val, ctx) => {
    if (val.aircraft_type === "Other" && !val.aircraft_type_other.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aircraft_type_other"],
        message: "Specify aircraft type",
      });
    }
  });

export type Sec016FormValues = z.infer<typeof sec016Schema>;

export const sec016Defaults: Sec016FormValues = {
  station: "",
  team: "",
  staff_name: "",
  staff_no: "",
  duty_date: "",
  duty_hour: "",
  flight: "",
  origin_arr_dep: "",
  assisted_by: "",
  aircraft_type: "A 320",
  aircraft_type_other: "",
  reg_no: "",
  sta_std: "",
  ata_atd: "",
  bay_no: "",
  reason_for_delay: "",
  do_infmd: "NO",
  inbound_baggage: "",
  outbound_baggage: "",
  inbound_cargo: "",
  outbound_cargo: "",
  inbound_co_mail: "",
  outbound_co_mail: "",
  checked_items: [],
  shift_leader: "",
  ramp_staff_1: "",
  ramp_staff_2: "",
  ramp_staff_3: "",
  ramp_staff_4: "",
  ramp_staff_5: "",
  cargo_hold_checked: "NO",
  staff_frisked: "NO",
  discrepancies: "",
  offload_flight_no: "",
  offload_destination: "",
  offload_baggage_tag_no: "",
  offload_total_baggage: "",
  offload_remark: "",
};
