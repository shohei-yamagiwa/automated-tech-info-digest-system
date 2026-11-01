import { describe, expect, it, vi } from "vitest";
import { parseSettings, type Interest, type Source } from "../config/config.js";
import { selectionSchema } from "../schemas/selection.js";
import { fakeFetch } from "../test-support/fake-fetch.js";
import type { Candidate } from "./dedupe.js";
import type { JudgedCandidate } from "./score.js";
import { runSelection, type SelectionInput } from "./run.js";

const since = new Date("2026-10-31T00:00:00Z");

const interests: Interest[] = [
  { name: "AI/LLM", description: "LLM の話題", weight: 1 },
  { name: "形式手法", description: "仕様記述と検証", weight: 1 },
];

const sources: Source[] = [
  { type: "rss", name: "Blog", url: "https://example.com/feed.xml" },
  { type: "hackernews", minPoints: 100 },
];

const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title><link>https://example.com</link><description>d</description>
<item><title>Post A</title><link>https://example.com/a</link><description>a</description><pubDate>Sat, 31 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>Post B</title><link>https://example.com/b</link><description>b</description><pubDate>Sat, 31 Oct 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

const hn = JSON.stringify({
  nbPages: 1,
  hits: [
    { objectID: "1", title: "Post A on HN", url: "https://example.com/a?utm_source=hn", points: 300, num_comments: 40 },
    { objectID: "2", title: "Post C", url: "https://example.com/c", points: 150, num_comments: 5 },
  ],
});

const byInputOrder = async (candidates: Candidate[]): Promise<JudgedCandidate[]> =>
  candidates.map((c, i) => ({
    ...c,
    relevance: 90 - i * 10,
    domain: "AI/LLM",
    topic: c.url,
  }));

const baseInput = (overrides: Partial<SelectionInput> = {}): SelectionInput => ({
  sources,
  interests,
  settings: parseSettings("{}"),
  since,
  seenUrls: [],
  fetch: fakeFetch({
    "https://example.com/feed.xml": feed,
    "hn.algolia.com": hn,
  }).fetch,
  judge: byInputOrder,
  ...overrides,
});

describe("runSelection", () => {
  it("収集・重複統合・既出除外・判定・スコア計算・選定を行い、有効な selection を返す", async () => {
    const { selection, failures } = await runSelection(
      baseInput({ seenUrls: ["https://example.com/b"] }),
    );

    expect(selectionSchema.safeParse(selection).success).toBe(true);
    expect(failures).toEqual([]);
    expect(selection.totalCandidates).toBe(2);
    expect(selection.selected.map((s) => s.url)).toEqual([
      "https://example.com/a",
      "https://example.com/c",
    ]);
    expect(selection.selected[0]?.popularity).toEqual([
      { source: "hackernews", name: "points", value: 300 },
      { source: "hackernews", name: "comments", value: 40 },
    ]);
  });

  it("選定されなかった候補にも、選ばれなかった理由を付ける", async () => {
    const { selection } = await runSelection(
      baseInput({
        judge: async (candidates) =>
          (await byInputOrder(candidates)).map((c) => ({ ...c, topic: "same" })),
      }),
    );

    const unselected = selection.candidates.filter((c) => !c.selected);
    expect(unselected.length).toBeGreaterThan(0);
    expect(unselected.every((c) => c.reason.includes("同じ話題"))).toBe(true);
    expect(selection.candidates.every((c) => c.reason.length > 0)).toBe(true);
  });

  it("1分野あたりの上限で外れた候補には、その旨の理由を付ける", async () => {
    const { selection } = await runSelection(
      baseInput({ settings: parseSettings("selection:\n  maxPerDomain: 1") }),
    );

    expect(selection.selected).toHaveLength(1);
    const unselected = selection.candidates.filter((c) => !c.selected);
    expect(unselected.every((c) => c.reason.includes("上限"))).toBe(true);
  });

  it("一部の情報源の取得に失敗しても、残りで処理を続けて失敗を報告する", async () => {
    const { selection, failures } = await runSelection(
      baseInput({
        fetch: fakeFetch({
          "https://example.com/feed.xml": { status: 500, body: "" },
          "hn.algolia.com": hn,
        }).fetch,
      }),
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.source).toBe("Blog");
    expect(selection.selected.length).toBeGreaterThan(0);
  });

  it("すべての情報源が失敗したらエラーにする", async () => {
    await expect(
      runSelection(
        baseInput({
          fetch: fakeFetch({
            "https://example.com/feed.xml": { status: 500, body: "" },
            "hn.algolia.com": { status: 500, body: "" },
          }).fetch,
        }),
      ),
    ).rejects.toThrow();
  });

  it("関連度判定に失敗したらエラーにする", async () => {
    await expect(
      runSelection(baseInput({ judge: vi.fn().mockRejectedValue(new Error("claude down")) })),
    ).rejects.toThrow("claude down");
  });
});
