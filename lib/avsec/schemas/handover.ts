import { z } from "zod";

/**
 * Input for filing a handover. The OUTGOING officer's identity (profile, name, staff ID, station, team) is never an input: the database derives it from
 * the signed-in session. The recipient is named by staff ID only; the server resolves and shows the officer's name.
 */
export const handoverSchema = z.object({
  recipient_staff_id: z
    .string()
    .trim()
    .min(1, "Enter the receiving officer's staff ID")
    .transform((s) => s.toUpperCase()),
  place_category: z.enum(["Bay", "Premises", "Terminal"], { message: "Select a place category" }),
  place_detail: z.string().trim().min(1, "Specify the place (e.g. Bay 12, Terminal 2)"),
  flight_number: z.string().trim().optional().default(""),
  handover_notes: z.string().trim().min(1, "Handover notes are required"),
});

export type HandoverInput = z.infer<typeof handoverSchema>;
