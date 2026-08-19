import { z } from "zod";
import { requiredText, timeString, yesNo, yesNoNa } from "./common";
import { SEC029_ITEMS } from "../reference-data";

export const sec029ItemSchema = z
  .object({
    item_code: z.string(),
    checked: yesNoNa,
    remark_type: z.enum(["nil", "other", "na"]),
    remark_text: z.string().trim().optional().default(""),
  })
  .superRefine((val, ctx) => {
    if (val.remark_type === "other" && !val.remark_text?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["remark_text"],
        message: "Remark / detection detail is required",
      });
    }
  });

export type Sec029ItemValues = z.infer<typeof sec029ItemSchema>;

export const sec029Schema = z
  .object({
    station: requiredText("Station"),
    team: requiredText("Team"),
    supervising_officer_name: requiredText("Supervising Officer Name"),
    supervising_officer_id: requiredText("Supervising Officer ID Number"),
    staff_name: requiredText("Staff Name"),
    staff_id: requiredText("Staff ID"),
    assisted_by_name: requiredText("Assisted By (Name)"),
    assisted_by_id: requiredText("Assisted By (ID Number)"),

    aircraft_type: z.enum(["A320", "A321", "A330"]),
    flight_no: requiredText("Flight No"),
    aircraft_registration: requiredText("Aircraft Registration"),
    std: timeString("STD"),
    parking_bay: requiredText("Parking Bay"),
    time_commence: timeString("Time Commence"),
    time_completed: timeString("Time Completed"),

    items: z.array(sec029ItemSchema).length(SEC029_ITEMS.length),

    pic_informed: yesNo,
    declaration: z.enum([
      "I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.",
      "DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)",
    ]),
    d_remark: z.string().trim().optional().default(""),
    acknowledgement: z
      .boolean()
      .refine((v) => v === true, { message: "Acknowledgement is required" }),
  })
  .superRefine((val, ctx) => {
    if (
      val.declaration ===
        "DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)" &&
      !val.d_remark?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["d_remark"],
        message: "Remark / detection detail is required when discrepancies are found",
      });
    }
  });

export type Sec029FormValues = z.infer<typeof sec029Schema>;

export const sec029Defaults: Sec029FormValues = {
  station: "",
  team: "",
  supervising_officer_name: "",
  supervising_officer_id: "",
  staff_name: "",
  staff_id: "",
  assisted_by_name: "",
  assisted_by_id: "",
  aircraft_type: "A320",
  flight_no: "",
  aircraft_registration: "",
  std: "",
  parking_bay: "",
  time_commence: "",
  time_completed: "",
  items: SEC029_ITEMS.map((item) => ({
    item_code: item.code,
    checked: "YES",
    remark_type: "nil",
    remark_text: "",
  })),
  pic_informed: "YES",
  declaration:
    "I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.",
  d_remark: "",
  acknowledgement: false,
};
