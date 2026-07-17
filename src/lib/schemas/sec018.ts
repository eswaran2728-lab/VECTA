import { z } from "zod";
import { requiredText } from "./common";

export const sec018PatrolEntrySchema = z.object({
  time_from: z.string().trim().nullable(),
  time_to: z.string().trim().nullable(),
  parking_bay: z.string().trim().nullable(),
  aircraft_type: z.string().trim().nullable(),
  reg_no: z.string().trim().nullable(),
  description: z.string().trim().optional().default(""),
});

export type Sec018PatrolEntryValues = z.infer<typeof sec018PatrolEntrySchema>;

export const sec018Schema = z.object({
  station: requiredText("Station"),
  team: requiredText("Team"),
  staff_name: requiredText("Name"),
  date_time: requiredText("Date & Time"),

  patrols: z.array(sec018PatrolEntrySchema).max(6, "Maximum 6 patrol entries"),

  acknowledgement: z
    .boolean()
    .refine((v) => v === true, { message: "Acknowledgement is required" }),
});

export type Sec018FormValues = z.infer<typeof sec018Schema>;

export const sec018Defaults: Sec018FormValues = {
  station: "",
  team: "",
  staff_name: "",
  date_time: "",
  patrols: [],
  acknowledgement: false,
};
