import { describe, expect, it } from "vitest";
import type { PopularitySignal } from "./dedupe.js";
import {
  scoreCandidates,
  selectTop,
  type JudgedCandidate,
  type ScoredCandidate,
  type ScoringConfig,
} from "./score.js";

const judged = (
  url: string,
  overrides: Partial<JudgedCandidate> = {},
): JudgedCandidate => ({
  url,
  title: url,
  popularity: [],
  relevance: 50,
  domain: "ai",
  topic: url,
  ...overrides,
});

const hn = (value: number): PopularitySignal => ({
  source: "hackernews",
  name: "points",
  value,
});
const hatena = (value: number): PopularitySignal => ({
  source: "hatena",
  name: "bookmarks",
  value,
});

describe("scoreCandidates", () => {
  const config: ScoringConfig = {
    domainWeights: { ai: 1, web: 1.5 },
    popularityStrength: 10,
  };

  it("人気度シグナルがなければ、関連度 × 分野の重みがスコアになる", () => {
    const [scored] = scoreCandidates(
      [judged("https://example.com/a", { relevance: 80, domain: "web" })],
      config,
    );

    expect(scored?.score).toBeCloseTo(120);
  });

  it("同じ情報源の候補どうしのパーセンタイルに応じて人気度補正が加算される", () => {
    const scored = scoreCandidates(
      [
        judged("https://example.com/a", { popularity: [hn(100)] }),
        judged("https://example.com/b", { popularity: [hn(300)] }),
      ],
      config,
    );

    expect(scored[0]?.score).toBeCloseTo(52.5);
    expect(scored[1]?.score).toBeCloseTo(57.5);
  });

  it("情報源が違う候補どうしでは人気度を比較しない", () => {
    const scored = scoreCandidates(
      [
        judged("https://example.com/a", { popularity: [hn(5)] }),
        judged("https://example.com/b", { popularity: [hatena(5000)] }),
      ],
      config,
    );

    expect(scored[0]?.score).toBeCloseTo(55);
    expect(scored[1]?.score).toBeCloseTo(55);
  });

  it("複数のシグナルを持つ場合は最大のパーセンタイルを使う", () => {
    const scored = scoreCandidates(
      [
        judged("https://example.com/a", { popularity: [hn(100), hatena(900)] }),
        judged("https://example.com/b", { popularity: [hn(300)] }),
        judged("https://example.com/c", { popularity: [hatena(100)] }),
      ],
      config,
    );

    expect(scored[0]?.score).toBeCloseTo(50 + 10 * 0.75);
  });

  it("重みが設定されていない分野の候補があればエラーにする", () => {
    expect(() =>
      scoreCandidates([judged("https://example.com/a", { domain: "unknown" })], config),
    ).toThrow();
  });
});

describe("selectTop", () => {
  const scored = (
    url: string,
    score: number,
    overrides: Partial<ScoredCandidate> = {},
  ): ScoredCandidate => ({ ...judged(url, overrides), score });

  it("スコアの高い順に指定した本数を選ぶ", () => {
    const result = selectTop(
      [scored("a", 10), scored("b", 30), scored("c", 20)],
      { count: 2, maxPerDomain: 10 },
    );

    expect(result.map((c) => c.url)).toEqual(["b", "c"]);
  });

  it("同じ話題からはスコアが最も高い1本だけを選ぶ", () => {
    const result = selectTop(
      [
        scored("a", 10, { topic: "t1" }),
        scored("b", 30, { topic: "t1" }),
        scored("c", 20, { topic: "t2" }),
      ],
      { count: 10, maxPerDomain: 10 },
    );

    expect(result.map((c) => c.url)).toEqual(["b", "c"]);
  });

  it("1分野あたりの上限を超えた分は次点の候補を繰り上げる", () => {
    const result = selectTop(
      [
        scored("a", 40, { domain: "ai" }),
        scored("b", 30, { domain: "ai" }),
        scored("c", 20, { domain: "ai" }),
        scored("d", 10, { domain: "web" }),
      ],
      { count: 3, maxPerDomain: 2 },
    );

    expect(result.map((c) => c.url)).toEqual(["a", "b", "d"]);
  });

  it("制約を満たす候補が足りなければ、選べた分だけ返す", () => {
    const result = selectTop(
      [scored("a", 40, { domain: "ai" }), scored("b", 30, { domain: "ai" })],
      { count: 10, maxPerDomain: 1 },
    );

    expect(result.map((c) => c.url)).toEqual(["a"]);
  });

  it("候補が空なら空配列を返す", () => {
    expect(selectTop([], { count: 10, maxPerDomain: 4 })).toEqual([]);
  });
});
