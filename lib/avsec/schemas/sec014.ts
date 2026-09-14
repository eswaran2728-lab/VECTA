import { z } from "zod";
import { requiredText } from "./common";

export const sec014PatrolEntrySchema = z.object({
  location: z.enum(["Apron", "Terminal", "Premises"]).nullable(),
  time_from: z.string().trim().nullable(),
  time_to: z.string().trim().nullable(),
  description: requiredText("Description / Report"),
});

export type Sec014PatrolEntryValues = z.infer<typeof sec014PatrolEntrySchema>;

export const sec014Schema = z.object({
  station: requiredText("Station"),
  team: requiredText("Team"),
  staff_name: requiredText("Name"),
  staff_id: requiredText("Staff ID"),
  date_time_in: requiredText("Date & Time In"),
  date_time_out: requiredText("Date & Time Out"),

  // No cap — staff may log as many patrol entries as actually happened during the shift.
  patrols: z.array(sec014PatrolEntrySchema),

  remark: requiredText("Issue(s) / Event(s) / Equipment(s)"),
  acknowledgement: z
    .boolean()
    .refine((v) => v === true, { message: "Acknowledgement is required" }),
});

export type Sec014FormValues = z.infer<typeof sec014Schema>;

export const sec014Defaults: Sec014FormValues = {
  station: "",
  team: "",
  staff_name: "",
  staff_id: "",
  date_time_in: "",
  date_time_out: "",
  patrols: [],
  remark: "",
  acknowledgement: false,
};
