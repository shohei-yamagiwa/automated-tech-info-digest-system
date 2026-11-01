import type { Interest, Settings, Source } from "../config/config.js";
import type { Selection } from "../schemas/selection.js";
import { collectFromSource } from "./collect.js";
import { mergeCandidates, type Candidate } from "./dedupe.js";
import { excludeSeen } from "./exclude-seen.js";
import {
  scoreCandidates,
  selectTop,
  type JudgedCandidate,
  type ScoredCandidate,
  type SelectionConfig,
} from "./score.js";

export type SourceFailure = { source: string; message: string };

export type SelectionInput = {
  sources: Source[];
  interests: Interest[];
  settings: Settings;
  since: Date;
  seenUrls: string[];
  fetch: typeof fetch;
  qiitaToken?: string;
  judge: (candidates: Candidate[], interests: Interest[]) => Promise<JudgedCandidate[]>;
};

export type SelectionResult = { selection: Selection; failures: SourceFailure[] };

const sourceLabel = (source: Source) => (source.type === "rss" ? source.name : source.type);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function unselectedReason(
  candidate: ScoredCandidate,
  selected: ScoredCandidate[],
  config: SelectionConfig,
): string {
  const sameTopic = selected.find((s) => s.topic === candidate.topic);
  if (sameTopic) return `同じ話題の記事「${sameTopic.title}」が選定されたため`;
  const inDomain = selected.filter((s) => s.domain === candidate.domain).length;
  if (inDomain >= config.maxPerDomain) {
    return `分野「${candidate.domain}」の上限(${config.maxPerDomain}本)に達したため`;
  }
  return `スコアが上位${config.count}本に入らなかったため`;
}

export async function runSelection(input: SelectionInput): Promise<SelectionResult> {
  const context = { fetch: input.fetch, since: input.since, qiitaToken: input.qiitaToken };
  const outcomes = await Promise.allSettled(
    input.sources.map((source) => collectFromSource(source, context)),
  );

  const collected: Candidate[] = [];
  const failures: SourceFailure[] = [];
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      collected.push(...outcome.value);
    } else {
      failures.push({
        source: sourceLabel(input.sources[i]!),
        message: messageOf(outcome.reason),
      });
    }
  });
  if (failures.length === input.sources.length) {
    throw new Error(
      `All sources failed: ${failures.map((f) => `${f.source} (${f.message})`).join("; ")}`,
    );
  }

  const candidates = excludeSeen(mergeCandidates(collected), input.seenUrls);
  const judged = await input.judge(candidates, input.interests);
  const scored = scoreCandidates(judged, {
    domainWeights: Object.fromEntries(input.interests.map((i) => [i.name, i.weight])),
    popularityStrength: input.settings.scoring.popularityStrength,
  }).sort((a, b) => b.score - a.score);

  const selectionConfig = input.settings.selection;
  const selected = selectTop(scored, selectionConfig);

  return {
    selection: {
      totalCandidates: scored.length,
      selected: selected.map((c, i) => ({
        rank: i + 1,
        url: c.url,
        title: c.title,
        score: c.score,
        domain: c.domain,
        topic: c.topic,
        popularity: c.popularity,
      })),
      candidates: scored.map((c) => {
        const rank = selected.indexOf(c) + 1;
        return {
          url: c.url,
          title: c.title,
          relevance: c.relevance,
          domain: c.domain,
          topic: c.topic,
          score: c.score,
          selected: rank > 0,
          reason:
            rank > 0
              ? `スコア上位${rank}位として選定`
              : unselectedReason(c, selected, selectionConfig),
        };
      }),
    },
    failures,
  };
}
