import { describe, expect, it } from "vitest";
import { selectionSchema } from "./selection.js";

const candidate = (url: string, selected: boolean) => ({
  url,
  title: `title of ${url}`,
  relevance: 80,
  domain: "ai",
  topic: url,
  score: 85.5,
  selected,
  reason: selected ? "上位スコア" : "同じ話題の上位記事がある",
});

const selectedArticle = (url: string, rank: number) => ({
  rank,
  url,
  title: `title of ${url}`,
  score: 85.5,
  domain: "ai",
  topic: url,
  popularity: [{ source: "hackernews", name: "points", value: 320 }],
});

const valid = () => ({
  totalCandidates: 3,
  selected: [
    selectedArticle("https://example.com/a", 1),
    selectedArticle("https://example.com/b", 2),
  ],
  candidates: [
    candidate("https://example.com/a", true),
    candidate("https://example.com/b", true),
    candidate("https://example.com/c", false),
  ],
});

describe("selectionSchema", () => {
  it("正しい形式の selection.json を受け入れる", () => {
    expect(selectionSchema.safeParse(valid()).success).toBe(true);
  });

  it("選定が0本でも受け入れる", () => {
    expect(
      selectionSchema.safeParse({ totalCandidates: 0, selected: [], candidates: [] })
        .success,
    ).toBe(true);
  });

  it("必須項目が欠けていれば拒否する", () => {
    const { totalCandidates: _, ...withoutTotal } = valid();

    expect(selectionSchema.safeParse(withoutTotal).success).toBe(false);
  });

  it("関連度が 0〜100 の範囲外なら拒否する", () => {
    const input = valid();
    input.candidates[0] = { ...candidate("https://example.com/a", true), relevance: 101 };

    expect(selectionSchema.safeParse(input).success).toBe(false);
  });

  it("順位が 1 から始まる連番でなければ拒否する", () => {
    const input = valid();
    input.selected[0] = selectedArticle("https://example.com/a", 2);

    expect(selectionSchema.safeParse(input).success).toBe(false);
  });

  it("候補の総数が候補一覧の件数と一致しなければ拒否する", () => {
    expect(selectionSchema.safeParse({ ...valid(), totalCandidates: 5 }).success).toBe(
      false,
    );
  });
});
