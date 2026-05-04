import { z } from "zod";

export const emailSchema = z
  .string({ required_error: "Email required" })
  .trim()
  .min(1, "Email required")
  .email("Invalid email")
  .transform((s) => s.toLowerCase());

export const passwordSchema = z
  .string({ required_error: "Password required" })
  .min(8, "Min 8 characters")
  .max(200, "Too long");

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });

const datetimeLocalToUnix = z
  .string({ required_error: "Required" })
  .min(1, "Required")
  .transform((s, ctx) => {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
      return z.NEVER;
    }
    return Math.floor(ms / 1000);
  });

export const electionFormSchema = z
  .object({
    title: z.string().trim().min(1, "Title required").max(200, "Too long"),
    description: z.string().max(2000, "Too long").optional().default(""),
    options: z
      .array(z.string().trim().min(1, "Empty option"))
      .min(2, "At least 2 options")
      .max(20, "Too many options"),
    startTime: datetimeLocalToUnix,
    endTime: datetimeLocalToUnix,
  })
  .refine((d) => d.endTime > d.startTime, {
    path: ["endTime"],
    message: "End must be after start",
  });
