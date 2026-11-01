import type { Candidate, PopularitySignal } from "./dedupe.js";

export type JudgedCandidate = Candidate & {
  relevance: number;
  domain: string;
  topic: string;
};

export type ScoredCandidate = JudgedCandidate & { score: number };

export type ScoringConfig = {
  domainWeights: Record<string, number>;
  popularityStrength: number;
};

export type SelectionConfig = {
  count: number;
  maxPerDomain: number;
};

const signalKey = (signal: PopularitySignal) => `${signal.source}:${signal.name}`;

export function scoreCandidates(
  candidates: JudgedCandidate[],
  config: ScoringConfig,
): ScoredCandidate[] {
  const valuesBySignal = new Map<string, number[]>();
  for (const candidate of candidates) {
    for (const signal of candidate.popularity) {
      const values = valuesBySignal.get(signalKey(signal)) ?? [];
      values.push(signal.value);
      valuesBySignal.set(signalKey(signal), values);
    }
  }

  const percentile = (signal: PopularitySignal) => {
    const values = valuesBySignal.get(signalKey(signal)) ?? [];
    const lower = values.filter((v) => v < signal.value).length;
    const equal = values.filter((v) => v === signal.value).length;
    return (lower + equal / 2) / values.length;
  };

  return candidates.map((candidate) => {
    const weight = config.domainWeights[candidate.domain];
    if (weight === undefined) {
      throw new Error(`No weight configured for domain: ${candidate.domain}`);
    }
    const popularity = Math.max(0, ...candidate.popularity.map(percentile));
    return {
      ...candidate,
      score: candidate.relevance * weight + config.popularityStrength * popularity,
    };
  });
}

export function selectTop(
  candidates: ScoredCandidate[],
  config: SelectionConfig,
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const topics = new Set<string>();
  const countByDomain = new Map<string, number>();

  const byScoreDesc = [...candidates].sort((a, b) => b.score - a.score);
  for (const candidate of byScoreDesc) {
    if (selected.length >= config.count) break;
    if (topics.has(candidate.topic)) continue;
    const domainCount = countByDomain.get(candidate.domain) ?? 0;
    if (domainCount >= config.maxPerDomain) continue;

    selected.push(candidate);
    topics.add(candidate.topic);
    countByDomain.set(candidate.domain, domainCount + 1);
  }
  return selected;
}
