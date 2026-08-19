import { z } from "zod";
import { requiredText, acknowledgementSchema } from "./common";
import { SEC013_DUTY_AREAS, SEC013_LOCATIONS } from "@/lib/avsec/reference-data";

export const sec013ProfilingDutyEntrySchema = z.object({
  duty_area: z.enum(SEC013_DUTY_AREAS, { errorMap: () => ({ message: "Duty Area is required" }) }),
  time_from: requiredText("Time From"),
  time_to: requiredText("Time To"),
  location: z.enum(SEC013_LOCATIONS, { errorMap: () => ({ message: "Location is required" }) }),
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
      duty_area: "Departure Gate",
      time_from: "",
      time_to: "",
      location: "Departure Gate Sector 5/6/7 (P-Q)",
      sector_flight: "",
      description: "",
      incident_remark: "",
    },
  ],
  remark: "",
  corrective_action: "",
  acknowledgement: false,
};
