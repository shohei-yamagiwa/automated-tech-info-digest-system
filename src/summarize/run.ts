import { z } from "zod";
import type { Settings } from "../config/config.js";
import { withRetry, type Sleep } from "../http/retry.js";
import { digestSchema, type Digest } from "../schemas/digest.js";
import type { Selection } from "../schemas/selection.js";
import type { StructuredCall } from "../selection/judge.js";

export type ArticleFailure = { url: string; title: string; message: string };

export type SummarizeInput = {
  selection: Selection;
  settings: Settings;
  summarizePrompt: string;
  fetch: typeof fetch;
  jinaApiKey: string;
  call: StructuredCall;
  sleep?: Sleep;
};

export type SummarizeResult = { digest: Digest; failures: ArticleFailure[] };

const articleSummarySchema = z.strictObject({
  title: z.string().min(1),
  what: z.string().min(1),
  why_it_matters: z.string().min(1),
  key_points: z.array(z.string().min(1)).min(1),
  caveats: z.array(z.string().min(1)),
});

const digestTitleSchema = z.strictObject({ title: z.string().min(1) });

const DIGEST_TITLE_PROMPT = `あなたは技術ダイジェストの編集者です。
その日に取り上げる記事の一覧(タイトルと概要)が与えられます。
一覧全体を表す、日本語の見出しを1つだけ作ってください。一覧にない事実は書かないでください。`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runSummarize(input: SummarizeInput): Promise<SummarizeResult> {
  const { selection, settings, sleep } = input;

  if (selection.selected.length === 0) throw new Error("No articles were selected");
  const target = selection.selected.length;
  const failures: ArticleFailure[] = [];

  const fetchBody = (url: string) =>
    withRetry(async () => {
      const response = await input.fetch(`https://r.jina.ai/${url}`, {
        headers: {
          Authorization: `Bearer ${input.jinaApiKey}`,
          "X-Return-Format": "markdown",
        },
      });
      if (!response.ok) throw new Error(`Jina Reader responded with HTTP ${response.status}`);
      const body = (await response.text()).trim();
      if (body === "") throw new Error("Jina Reader returned an empty body");
      const header = body.split("Markdown Content:")[0]!;
      const targetError = /^Warning: Target URL returned error (\d+)/m.exec(header);
      if (targetError) {
        throw new Error(`Target URL returned HTTP ${targetError[1]} via Jina Reader`);
      }
      return body;
    }, sleep);

  type Kept = {
    rank: number;
    score: number;
    url: string;
    title: string;
    domain: string;
    topic: string;
    body: string;
  };
  const kept: Kept[] = [];

  const firstOutcomes = await Promise.allSettled(
    selection.selected.map((article) => fetchBody(article.url)),
  );
  firstOutcomes.forEach((outcome, i) => {
    const article = selection.selected[i]!;
    if (outcome.status === "fulfilled") {
      kept.push({ ...article, body: outcome.value });
    } else {
      failures.push({ url: article.url, title: article.title, message: messageOf(outcome.reason) });
    }
  });

  const fallbacks = selection.candidates
    .filter((candidate) => !candidate.selected)
    .sort((a, b) => b.score - a.score);
  let nextRank = target + 1;
  for (const candidate of fallbacks) {
    if (kept.length >= target) break;
    if (kept.some((k) => k.topic === candidate.topic)) continue;
    const domainCount = kept.filter((k) => k.domain === candidate.domain).length;
    if (domainCount >= settings.selection.maxPerDomain) continue;

    let body: string;
    try {
      body = await fetchBody(candidate.url);
    } catch (error) {
      failures.push({ url: candidate.url, title: candidate.title, message: messageOf(error) });
      continue;
    }
    kept.push({ ...candidate, rank: nextRank++, body });
  }

  if (kept.length === 0) {
    throw new Error(
      `No article body could be fetched: ${failures.map((f) => `${f.url} (${f.message})`).join("; ")}`,
    );
  }

  const summaries = await Promise.all(
    kept.map((article) =>
      withRetry(
        async () =>
          articleSummarySchema.parse(
            await input.call({
              system: input.summarizePrompt,
              user: `# 記事のURL\n${article.url}\n\n# 元のタイトル\n${article.title}\n\n# 本文\n${article.body}`,
              schema: z.toJSONSchema(articleSummarySchema) as Record<string, unknown>,
            }),
          ),
        sleep,
      ),
    ),
  );

  const { title } = await withRetry(
    async () =>
      digestTitleSchema.parse(
        await input.call({
          system: DIGEST_TITLE_PROMPT,
          user: summaries.map((s) => `- ${s.title}: ${s.what}`).join("\n"),
          schema: z.toJSONSchema(digestTitleSchema) as Record<string, unknown>,
        }),
      ),
    sleep,
  );

  const digest = digestSchema.parse({
    title,
    totalCandidates: selection.totalCandidates,
    articles: kept
      .map((article, i) => ({
        rank: article.rank,
        score: article.score,
        url: article.url,
        domain: article.domain,
        ...summaries[i]!,
      }))
      .sort((a, b) => a.rank - b.rank),
  });

  return { digest, failures };
}
