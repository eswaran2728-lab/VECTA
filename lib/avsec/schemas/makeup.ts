import { z } from "zod";
import { requiredText, timeString, dateString } from "./common.ts";

export const makeupBaggageEntrySchema = z.object({
  entry_no: z.number().int().positive().optional(),
  container_pallet_trolley_no: requiredText("Container / Pallet / Trolley No"),
  seal_no: requiredText("Seal No"),
  bay: requiredText("Bay"),
  destination: requiredText("Destination"),
});

export type MakeupBaggageEntryValues = z.infer<typeof makeupBaggageEntrySchema>;

export const makeupDiscrepancySchema = z.object({
  entry_no: z.number().int().positive().optional(),
  baggage_tag_no: z.string().trim().optional().default(""),
  details: z.string().trim().optional().default(""),
});

export type MakeupDiscrepancyValues = z.infer<typeof makeupDiscrepancySchema>;

export const makeupSchema = z.object({
  // Header
  station: requiredText("Station"),
  flight_number: requiredText("Flight Number"),
  duty_date: dateString("Operational Date"),
  team: requiredText("Shift / Team"),
  destination: requiredText("Destination"),

  // Timing
  first_baggage_time: timeString("First baggage received time"),
  last_baggage_tag_time: timeString("Last baggage tag received time"),

  // Repeatable baggage entries (min 1)
  baggage_entries: z
    .array(makeupBaggageEntrySchema)
    .min(1, "At least one baggage entry is required"),

  // Additional sections
  ground_handling_personnel: z.string().trim().optional().default(""),
  remarks: z.string().trim().optional().default(""),
  discrepancies: z.array(makeupDiscrepancySchema).optional().default([]),

  // Officer confirmation checkbox before submission
  officer_confirmation: z
    .boolean()
    .refine((v) => v === true, { message: "Officer confirmation is required before submission" }),
});

export type MakeupFormValues = z.infer<typeof makeupSchema>;

export const makeupDefaults: MakeupFormValues = {
  station: "",
  flight_number: "",
  duty_date: "",
  team: "",
  destination: "",
  first_baggage_time: "",
  last_baggage_tag_time: "",
  baggage_entries: [
    {
      container_pallet_trolley_no: "",
      seal_no: "",
      bay: "",
      destination: "",
    },
  ],
  ground_handling_personnel: "",
  remarks: "",
  discrepancies: [],
  officer_confirmation: false,
};
