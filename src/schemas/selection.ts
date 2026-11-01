import { z } from "zod";

const popularitySignalSchema = z.strictObject({
  source: z.string().min(1),
  name: z.string().min(1),
  value: z.number().nonnegative(),
});

const selectedArticleSchema = z.strictObject({
  rank: z.int().min(1),
  url: z.url(),
  title: z.string().min(1),
  score: z.number(),
  domain: z.string().min(1),
  topic: z.string().min(1),
  popularity: z.array(popularitySignalSchema),
});

const candidateRecordSchema = z.strictObject({
  url: z.url(),
  title: z.string().min(1),
  relevance: z.number().min(0).max(100),
  domain: z.string().min(1),
  topic: z.string().min(1),
  score: z.number(),
  selected: z.boolean(),
  reason: z.string().min(1),
});

export const selectionSchema = z
  .strictObject({
    totalCandidates: z.int().nonnegative(),
    selected: z.array(selectedArticleSchema),
    candidates: z.array(candidateRecordSchema),
  })
  .refine((s) => s.selected.every((article, i) => article.rank === i + 1), {
    message: "ranks must be consecutive starting from 1",
  })
  .refine((s) => s.totalCandidates === s.candidates.length, {
    message: "totalCandidates must equal the number of candidates",
  });

export type Selection = z.infer<typeof selectionSchema>;
