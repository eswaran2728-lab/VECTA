import { z } from "zod";

export const requiredText = (label: string) =>
  z.string().trim().min(1, `${label} is required`);

export const optionalText = z.string().trim().optional().default("");

export const yesNo = z.enum(["YES", "NO"]);
export const yesNoNa = z.enum(["YES", "NO", "NA"]);

// HH:MM (24h) time input
export const timeString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be a valid time (HH:MM)`);

export const dateString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a valid date (YYYY-MM-DD)`);

export const acknowledgementSchema = z
  .boolean()
  .refine((v) => v === true, { message: "Acknowledgement is required" });
