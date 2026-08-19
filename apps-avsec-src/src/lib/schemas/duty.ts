import { z } from "zod";
import { requiredText, dateString } from "./common";

export const OT_CATEGORIES = ["flight_delay", "manpower_shortage", "event", "off_day_work", "adhoc"] as const;

// `client_timestamp` lets the server reject a payload that's been sitting offline too
// long (drift check); `offline` records whether the *original* attempt was made without
// connectivity, so it's carried through unchanged when the item is queued and replayed.
export const dutyCheckInSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracy_m: z.number(),
  late_remark: z.string(),
  offline: z.boolean(),
  client_timestamp: z.string(),
});
export type DutyCheckInInput = z.infer<typeof dutyCheckInSchema>;

export const dutyCheckOutSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  early_out_remark: z.string(),
  offline: z.boolean(),
  client_timestamp: z.string(),
});
export type DutyCheckOutInput = z.infer<typeof dutyCheckOutSchema>;

// `start_at`/`end_at` are datetime-local input values ("YYYY-MM-DDTHH:mm"), combined with
// the MY (UTC+8) offset server-side — same assumption as the rest of the app's datetime
// handling (see combineDateTimeMY). work_date is the "OT day" used for roster lookups.
export const overtimeRequestSchema = z.object({
  work_date: dateString("Work date"),
  start_at: requiredText("Start time"),
  end_at: requiredText("End time"),
  category: z.enum(OT_CATEGORIES),
  reason: requiredText("Reason"),
  shift_code: z.string().trim().optional().default(""),
  linked_duty_id: z.string().trim().optional().default(""),
});
export type OvertimeRequestInput = z.infer<typeof overtimeRequestSchema>;
