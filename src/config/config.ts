import { parse } from "yaml";
import { z } from "zod";

const interestsSchema = z.strictObject({
  interests: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        description: z.string().min(1),
        weight: z.number().positive().default(1),
      }),
    )
    .min(1)
    .refine((items) => new Set(items.map((i) => i.name)).size === items.length, {
      message: "interest names must be unique",
    }),
});

const sourcesSchema = z.strictObject({
  sources: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("rss"), name: z.string().min(1), url: z.url() }),
        z.strictObject({
          type: z.literal("hackernews"),
          minPoints: z.number().int().nonnegative().default(100),
        }),
        z.strictObject({ type: z.literal("github-trending") }),
        z.strictObject({ type: z.literal("hatena-hotentry") }),
        z.strictObject({
          type: z.literal("zenn"),
          topics: z.array(z.string().min(1)).default([]),
        }),
        z.strictObject({ type: z.literal("qiita") }),
      ]),
    )
    .min(1),
});

const settingsSchema = z.strictObject({
  selection: z
    .strictObject({
      count: z.number().int().min(1).default(10),
      maxPerDomain: z.number().int().min(1).default(4),
    })
    .prefault({}),
  scoring: z
    .strictObject({ popularityStrength: z.number().nonnegative().default(10) })
    .prefault({}),
  models: z
    .strictObject({
      relevance: z.string().min(1).default("claude-sonnet-5-5"),
      summarize: z.string().min(1).default("claude-opus-5-5"),
    })
    .prefault({}),
  slides: z
    .strictObject({ numCards: z.number().int().min(1).default(25) })
    .prefault({}),
});

export type Interest = z.infer<typeof interestsSchema>["interests"][number];
export type Source = z.infer<typeof sourcesSchema>["sources"][number];
export type Settings = z.infer<typeof settingsSchema>;

export function parseInterests(yaml: string): Interest[] {
  return interestsSchema.parse(parse(yaml)).interests;
}

export function parseSources(yaml: string): Source[] {
  return sourcesSchema.parse(parse(yaml)).sources;
}

export function parseSettings(yaml: string): Settings {
  return settingsSchema.parse(parse(yaml));
}
