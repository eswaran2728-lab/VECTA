import { z } from "zod";
import { requiredText, timeString, dateString, yesNo } from "./common.ts";

// AA/SEC/F/016 Rev.03 — direction-specific ASO Attending Flight Report.
// Arrival and Departure share the same underlying schema/table; which fields are
// required depends entirely on `flight_type`, enforced below via superRefine rather
// than two separate schemas, so a single form/table/PDF/view keep working for both.
export const sec016Schema = z
  .object({
    // flight direction
    flight_type: z.enum(["arrival", "departure"]).default("arrival"),
    aircraft_search_completed: z.boolean().default(false),

    // staff details
    station: requiredText("Station"),
    team: requiredText("Team"),
    staff_name: requiredText("Name"),
    staff_no: requiredText("Staff No"),
    duty_date: dateString("Duty date"),
    duty_hour: timeString("Duty hour"),

    // aircraft
    flight: requiredText("Flight"),
    origin_arr_dep: requiredText("Origin / Destination"),
    assisted_by: requiredText("Assisted By"),
    aircraft_type: z.enum(["A 320", "A 321", "A 330", "Other"]),
    aircraft_type_other: z.string().trim().optional().default(""),
    reg_no: requiredText("Reg No"),
    sta_std: timeString("STA / STD"),
    ata_atd: timeString("ATA / ATD"),
    bay_no: requiredText("Bay No"),
    reason_for_delay: z.string().trim().optional().default(""),
    do_infmd: yesNo,

    // direction-specific baggage/cargo/co-mail — only one side is required,
    // enforced in superRefine below; the other is sent through as "" (not shown
    // to the user, never treated as real information for the opposite direction).
    inbound_baggage: z.string().trim().optional().default(""),
    outbound_baggage: z.string().trim().optional().default(""),
    inbound_cargo: z.string().trim().optional().default(""),
    outbound_cargo: z.string().trim().optional().default(""),
    inbound_co_mail: z.string().trim().optional().default(""),
    outbound_co_mail: z.string().trim().optional().default(""),

    // Ramp Loading Supervisor (RLS) — same field as the old "Shift Leader (Ground Handler)".
    shift_leader: requiredText("Ramp Loading Supervisor (RLS)"),
    // Multiline "Name ID (hold)" / "Name ID (tarmac)" entries — replaces the old
    // five individual ramp_staff_1..5 slots.
    ramp_agents_baggage: requiredText("Ramp agent details (baggage)"),
    ramp_agents_cargo: requiredText("Ramp agent details (cargo)"),

    cargo_hold_checked: yesNo,
    staff_frisked: yesNo,
    // No new mandatory requirement — optional, unset unless the officer picks one.
    cabin_check: z.enum(["YES", "NO"]).optional(),

    discrepancies: requiredText("Discrepancies (if any)").or(z.literal("N/A")),

    // Offload Information — Departure only. Optional at the schema level (Arrival
    // never sends these); superRefine requires them specifically for Departure.
    offload_baggage_tag_no: z.string().trim().optional().default(""),
    offload_remark: z.string().trim().optional().default(""),
  })
  .superRefine((val, ctx) => {
    if (val.aircraft_type === "Other" && !val.aircraft_type_other.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aircraft_type_other"],
        message: "Specify aircraft type",
      });
    }

    if (val.flight_type === "arrival") {
      if (!val.inbound_baggage.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["inbound_baggage"], message: "Inbound Baggage is required" });
      }
      if (!val.inbound_cargo.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["inbound_cargo"], message: "Inbound Cargo is required" });
      }
      if (!val.inbound_co_mail.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["inbound_co_mail"], message: "Inbound Co-Mail / Comat is required" });
      }
    } else {
      if (!val.outbound_baggage.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outbound_baggage"], message: "Outbound Baggage is required" });
      }
      if (!val.outbound_cargo.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outbound_cargo"], message: "Outbound Cargo is required" });
      }
      if (!val.outbound_co_mail.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outbound_co_mail"], message: "Outbound Co-Mail / Comat is required" });
      }
      if (!val.offload_baggage_tag_no.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offload_baggage_tag_no"], message: "Baggage Tag No is required" });
      }
      if (!val.offload_remark.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offload_remark"], message: "Remark is required" });
      }
    }

    // Discrepancy photo requirement (spec item 4): when "Baggage discrepancy" was
    // quick-added, at least one photo attachment is mandatory — a PDF alone doesn't
    // satisfy it. Attachments aren't part of this schema (they upload separately
    // after the report row is inserted — see useOfflineSubmit), so the actual gate
    // lives in Sec016Form's onSubmit right before calling submit(); this schema only
    // validates the fields that live in the row itself.
  });

export type Sec016FormValues = z.infer<typeof sec016Schema>;

export const sec016Defaults: Sec016FormValues = {
  flight_type: "arrival",
  aircraft_search_completed: false,
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
  shift_leader: "",
  ramp_agents_baggage: "",
  ramp_agents_cargo: "",
  cargo_hold_checked: "NO",
  staff_frisked: "NO",
  cabin_check: undefined,
  discrepancies: "",
  offload_baggage_tag_no: "",
  offload_remark: "",
};
