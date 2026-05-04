import { z } from "zod";

export const castVoteSchema = z.object({
  selectedOption: z.number().int().min(0).max(31),
});
