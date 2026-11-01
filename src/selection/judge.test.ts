import { describe, expect, it, vi } from "vitest";
import type { Interest } from "../config/config.js";
import type { Candidate } from "./dedupe.js";
import { judgeRelevance, type StructuredCall } from "./judge.js";

const interests: Interest[] = [
  { name: "AI/LLM", description: "LLM の話題", weight: 1 },
  { name: "形式手法", description: "仕様記述と検証", weight: 1 },
];

const candidates: Candidate[] = [
  { url: "https://example.com/a", title: "GPT の新機能", summary: "概要A", popularity: [] },
  { url: "https://example.com/b", title: "TLA+ 入門", popularity: [] },
];

const goodResponse = {
  judgements: [
    { index: 0, relevance: 90, domain: "AI/LLM", topic: "gpt-update" },
    { index: 1, relevance: 40, domain: "形式手法", topic: "tla" },
  ],
};

const noSleep = async () => {};

describe("judgeRelevance", () => {
  it("全候補を1回の呼び出しで判定し、関連度・分野・話題を付与する", async () => {
    const call = vi.fn<StructuredCall>().mockResolvedValue(goodResponse);

    const result = await judgeRelevance(candidates, interests, call, { sleep: noSleep });

    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject([
      { url: "https://example.com/a", relevance: 90, domain: "AI/LLM", topic: "gpt-update" },
      { url: "https://example.com/b", relevance: 40, domain: "形式手法", topic: "tla" },
    ]);
  });

  it("関心領域の説明と、候補のタイトル・概要を Claude に渡す", async () => {
    const call = vi.fn<StructuredCall>().mockResolvedValue(goodResponse);

    await judgeRelevance(candidates, interests, call, { sleep: noSleep });

    const { system, user } = call.mock.calls[0]![0];
    expect(system).toContain("LLM の話題");
    expect(system).toContain("仕様記述と検証");
    expect(user).toContain("GPT の新機能");
    expect(user).toContain("概要A");
    expect(user).toContain("TLA+ 入門");
  });

  it("候補が空なら Claude を呼ばずに空配列を返す", async () => {
    const call = vi.fn<StructuredCall>();

    await expect(judgeRelevance([], interests, call)).resolves.toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("一時的に失敗しても再試行して結果を返す", async () => {
    const call = vi
      .fn<StructuredCall>()
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockResolvedValue(goodResponse);
    const sleeps: number[] = [];

    const result = await judgeRelevance(candidates, interests, call, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("関心領域にない分野が返されたらエラーにする", async () => {
    const call = vi.fn<StructuredCall>().mockResolvedValue({
      judgements: [
        { index: 0, relevance: 90, domain: "未知の分野", topic: "x" },
        { index: 1, relevance: 40, domain: "形式手法", topic: "y" },
      ],
    });

    await expect(
      judgeRelevance(candidates, interests, call, { sleep: noSleep }),
    ).rejects.toThrow();
  });

  it("判定が返されなかった候補があればエラーにする", async () => {
    const call = vi.fn<StructuredCall>().mockResolvedValue({
      judgements: [{ index: 0, relevance: 90, domain: "AI/LLM", topic: "x" }],
    });

    await expect(
      judgeRelevance(candidates, interests, call, { sleep: noSleep }),
    ).rejects.toThrow();
  });
});
