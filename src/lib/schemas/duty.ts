import { z } from "zod";

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
