import { z } from "zod";
import { requiredText, optionalText, dateString } from "./common";

// e.g. AK123, MH1, D7212A — 2-3 letter/digit airline code + 1-4 digits + optional suffix letter.
const FLIGHT_NO_RE = /^[A-Z0-9]{1,3}\d{1,4}[A-Z]?$/;

const flightNo = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "Flight No is required")
  .regex(FLIGHT_NO_RE, "Flight No must look like a real flight number (e.g. AK123)");

export const offloadItemSchema = z.object({
  baggage_tag_no: requiredText("Baggage Tag No"),
  reason: optionalText,
  weight_kg: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((v) => v === "" || (!Number.isNaN(Number(v)) && Number(v) >= 0), {
      message: "Weight must be a positive number",
    }),
});

export type OffloadItemValues = z.infer<typeof offloadItemSchema>;

export const offloadSchema = z.object({
  station: requiredText("Station"),
  team: requiredText("Team"),
  staff_name: requiredText("Name"),
  staff_id: requiredText("Staff ID"),

  flight_no: flightNo,
  destination: requiredText("Destination"),
  aircraft_registration: requiredText("Aircraft Registration"),
  flight_date: dateString("Flight Date"),
  std: z.string().trim().optional().default(""),
  remark: optionalText,

  verified_by_dse_name: optionalText,
  verified_by_dse_id: optionalText,

  items: z.array(offloadItemSchema).min(1, "At least one offloaded baggage entry is required"),
});

export type OffloadFormValues = z.infer<typeof offloadSchema>;

export const offloadDefaults: OffloadFormValues = {
  station: "",
  team: "",
  staff_name: "",
  staff_id: "",
  flight_no: "",
  destination: "",
  aircraft_registration: "",
  flight_date: "",
  std: "",
  remark: "",
  verified_by_dse_name: "",
  verified_by_dse_id: "",
  items: [{ baggage_tag_no: "", reason: "", weight_kg: "" }],
};
