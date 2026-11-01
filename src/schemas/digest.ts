import { z } from "zod";

export const digestSchema = z
  .strictObject({
    title: z.string().min(1),
    totalCandidates: z.int().nonnegative(),
    articles: z
      .array(
        z.strictObject({
          rank: z.int().min(1),
          score: z.number(),
          url: z.url(),
          domain: z.string().min(1),
          title: z.string().min(1),
          what: z.string().min(1),
          why_it_matters: z.string().min(1),
          key_points: z.array(z.string().min(1)).min(1),
          caveats: z.array(z.string().min(1)),
        }),
      )
      .min(1),
  })
  .refine((d) => new Set(d.articles.map((a) => a.rank)).size === d.articles.length, {
    message: "ranks must be unique",
  });

export type Digest = z.infer<typeof digestSchema>;
