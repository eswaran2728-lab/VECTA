import { z } from "zod";

export const handoverSchema = z.object({
  team: z.string().min(1, "Team is required"),
  staff_name: z.string().min(1, "Staff name is required"),
  staff_id: z.string().min(1, "Staff ID is required"),
  place_category: z.enum(["Bay", "Premises", "Terminal"], { message: "Select a place category" }),
  place_detail: z.string().min(1, "Specify the place (e.g. Bay 12, Terminal 2)"),
  flight_number: z.string().optional().default(""),
  handover_notes: z.string().min(1, "Handover notes are required"),
});

export type HandoverInput = z.infer<typeof handoverSchema>;
