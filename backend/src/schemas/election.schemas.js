import { z } from "zod";

export const createElectionSchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().max(2000).default(""),
    options: z.array(z.string().min(1).max(200)).min(2).max(32),
    startTime: z.number().int().positive(),
    endTime: z.number().int().positive(),
  })
  .refine((d) => d.endTime > d.startTime, {
    message: "endTime must be greater than startTime",
    path: ["endTime"],
  });

export const electionIdParam = z.object({
  id: z.string().regex(/^\d+$/, "id must be a non-negative integer"),
});
