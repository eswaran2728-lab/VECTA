import { z } from "zod";
import { requiredText, acknowledgementSchema } from "./common";
import { SEC013_DUTY_AREA_VALUE } from "@/lib/avsec/reference-data";

export const sec013ProfilingDutyEntrySchema = z.object({
  // Duty Area is a fixed, pre-filled value (AA/SEC/F/013 Rev.03 currently only
  // covers Departure Gate profiling) — stored the same way as before, just no
  // longer user-selectable, so historical rows with the same value stay valid.
  duty_area: z.literal(SEC013_DUTY_AREA_VALUE),
  time_from: requiredText("Passport Check – Commencement Time"),
  time_to: requiredText("Passport Check – Completion Time"),
  // Manually typed free text (was a fixed dropdown of pre-set locations).
  location: requiredText("Location"),
  sector_flight: requiredText("Sector Flight"),
  description: requiredText("Description / Daily Report"),
  incident_remark: z.string().trim().optional().default(""),
});

export type Sec013ProfilingDutyEntryValues = z.infer<typeof sec013ProfilingDutyEntrySchema>;

export const sec013Schema = z.object({
  station: requiredText("Hub/Station"),
  team: requiredText("Team"),
  staff_name: requiredText("Name"),
  staff_id: requiredText("Staff ID"),
  date_time_in: requiredText("Date & Time In"),
  date_time_out: requiredText("Date & Time Out"),

  profiling_duties: z.array(sec013ProfilingDutyEntrySchema).min(1, "At least one profiling duty entry is required"),

  remark: z.string().trim().optional().default(""),
  corrective_action: z.string().trim().optional().default(""),
  acknowledgement: acknowledgementSchema,
});

export type Sec013FormValues = z.infer<typeof sec013Schema>;

export const sec013Defaults: Sec013FormValues = {
  station: "",
  team: "",
  staff_name: "",
  staff_id: "",
  date_time_in: "",
  date_time_out: "",
  profiling_duties: [
    {
      duty_area: SEC013_DUTY_AREA_VALUE,
      time_from: "",
      time_to: "",
      location: "",
      sector_flight: "",
      description: "",
      incident_remark: "",
    },
  ],
  remark: "",
  corrective_action: "",
  acknowledgement: false,
};
