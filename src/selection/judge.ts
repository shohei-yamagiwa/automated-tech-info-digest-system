import { z } from "zod";
import type { Interest } from "../config/config.js";
import { withRetry, type Sleep } from "../http/retry.js";
import type { Candidate } from "./dedupe.js";
import type { JudgedCandidate } from "./score.js";

export type StructuredCall = (request: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}) => Promise<unknown>;

const SUMMARY_MAX_LENGTH = 500;

const SYSTEM_PROMPT = `あなたは技術記事の選定アシスタントです。
与えられた各記事について、タイトルと概要だけを根拠に、次の3つを判定してください。

- relevance: 下記の関心領域にどれだけ合致するか(0〜100の整数)
- domain: 最も近い関心領域の名前(下記の名前のいずれか)
- topic: 話題のまとまりを表す短いラベル。同じ出来事・同じ製品・同じ話題を扱う記事には、必ず完全に同じラベルを付けること。

すべての記事について、index を付けて1件ずつ判定を返してください。

# 関心領域
`;

export async function judgeRelevance(
  candidates: Candidate[],
  interests: Interest[],
  call: StructuredCall,
  options: { sleep?: Sleep } = {},
): Promise<JudgedCandidate[]> {
  if (candidates.length === 0) return [];

  const domains = interests.map((i) => i.name) as [string, ...string[]];
  const responseSchema = z.object({
    judgements: z.array(
      z.object({
        index: z.int().min(0).max(candidates.length - 1),
        relevance: z.number().min(0).max(100),
        domain: z.enum(domains),
        topic: z.string().min(1),
      }),
    ),
  });

  const request = {
    system:
      SYSTEM_PROMPT +
      interests.map((i) => `- ${i.name}: ${i.description}`).join("\n"),
    user: candidates
      .map((c, index) => {
        const summary = c.summary?.slice(0, SUMMARY_MAX_LENGTH);
        return `[${index}] ${c.title}${summary ? `\n${summary}` : ""}`;
      })
      .join("\n\n"),
    schema: z.toJSONSchema(responseSchema) as Record<string, unknown>,
  };

  const byIndex = await withRetry(async () => {
    const { judgements } = responseSchema.parse(await call(request));
    const judged = new Map(judgements.map((j) => [j.index, j]));
    if (judged.size !== candidates.length) {
      throw new Error(
        `Expected judgements for ${candidates.length} candidates but got ${judged.size}`,
      );
    }
    return judged;
  }, options.sleep);

  return candidates.map((candidate, index) => {
    const { relevance, domain, topic } = byIndex.get(index)!;
    return { ...candidate, relevance, domain, topic };
  });
}
