import { z } from "zod";
import { requiredText } from "./common";

export const sec033HoldCheckEntrySchema = z.object({
  parking_bay_no: requiredText("Parking Bay No"),
  aircraft_registration_no: requiredText("A/C Registration No"),
  remarks: z.string().trim().optional().default(""),
});

export type Sec033HoldCheckEntryValues = z.infer<typeof sec033HoldCheckEntrySchema>;

export const sec033Schema = z.object({
  station: requiredText("Station"),
  team: requiredText("Team"),
  staff_name: requiredText("Name"),
  staff_id: requiredText("Staff ID"),
  report_date: requiredText("Date"),
  report_time: requiredText("Time"),

  hold_checks: z
    .array(sec033HoldCheckEntrySchema)
    .min(1, "At least one hold check entry is required"),
});

export type Sec033FormValues = z.infer<typeof sec033Schema>;

export const sec033Defaults: Sec033FormValues = {
  station: "",
  team: "",
  staff_name: "",
  staff_id: "",
  report_date: "",
  report_time: "",
  hold_checks: [{ parking_bay_no: "", aircraft_registration_no: "", remarks: "" }],
};
