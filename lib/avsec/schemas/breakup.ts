import { z } from "zod";
import { requiredText, timeString, dateString } from "./common.ts";

export const breakupBaggageEntrySchema = z.object({
  entry_no: z.number().int().positive().optional(),
  container_pallet_trolley_no: requiredText("Container / Pallet / Trolley No"),
  baggage_tag_no: z.string().trim().optional().default(""),
  discrepancy_details: z.string().trim().optional().default(""),
});

export type BreakupBaggageEntryValues = z.infer<typeof breakupBaggageEntrySchema>;

export const breakupSchema = z.object({
  // Header
  station: requiredText("Station"),
  flight_number: requiredText("Flight Number"),
  duty_date: dateString("Operational Date"),
  team: requiredText("Shift / Team"),
  origin: requiredText("Origin"),

  // Timing
  first_container_time: timeString("First container received time"),
  last_container_time: timeString("Last container received time"),

  // Repeatable baggage entries (min 1)
  baggage_entries: z
    .array(breakupBaggageEntrySchema)
    .min(1, "At least one baggage entry is required"),

  // Additional sections
  ground_handling_personnel: z.string().trim().optional().default(""),
  pir_dpr_details: z.string().trim().optional().default(""),

  // Officer confirmation that arrival baggage containers were inspected after offloading and nothing was left behind
  containers_inspected_clean: z
    .boolean()
    .refine((v) => v === true, {
      message:
        "Officer confirmation that arrival baggage containers were inspected after offloading and nothing was left behind is required",
    }),
});

export type BreakupFormValues = z.infer<typeof breakupSchema>;

export const breakupDefaults: BreakupFormValues = {
  station: "",
  flight_number: "",
  duty_date: "",
  team: "",
  origin: "",
  first_container_time: "",
  last_container_time: "",
  baggage_entries: [
    {
      container_pallet_trolley_no: "",
      baggage_tag_no: "",
      discrepancy_details: "",
    },
  ],
  ground_handling_personnel: "",
  pir_dpr_details: "",
  containers_inspected_clean: false,
};
