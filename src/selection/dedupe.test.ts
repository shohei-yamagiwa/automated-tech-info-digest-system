import { describe, expect, it } from "vitest";
import { mergeCandidates, normalizeUrl, type Candidate } from "./dedupe.js";

describe("normalizeUrl", () => {
  it("ホスト名を小文字にし、フラグメントを除去する", () => {
    expect(normalizeUrl("https://Example.COM/post#section")).toBe(
      "https://example.com/post",
    );
  });

  it("末尾のスラッシュを除去する", () => {
    expect(normalizeUrl("https://example.com/post/")).toBe(
      "https://example.com/post",
    );
  });

  it("トラッキング用のクエリを除去し、それ以外は残す", () => {
    expect(
      normalizeUrl("https://example.com/post?utm_source=rss&id=42&utm_medium=x"),
    ).toBe("https://example.com/post?id=42");
  });

  it("クエリの順序が違っても同じ結果になる", () => {
    expect(normalizeUrl("https://example.com/p?a=1&b=2")).toBe(
      normalizeUrl("https://example.com/p?b=2&a=1"),
    );
  });

  it("URL として不正な文字列はエラーにする", () => {
    expect(() => normalizeUrl("not a url")).toThrow();
  });
});

describe("mergeCandidates", () => {
  const hn = { source: "hackernews", name: "points", value: 320 };
  const hatena = { source: "hatena", name: "bookmarks", value: 150 };

  it("正規化後に同じ URL の候補を1件にまとめ、人気度シグナルをすべて保持する", () => {
    const candidates: Candidate[] = [
      { url: "https://example.com/post?utm_source=hn", title: "A", popularity: [hn] },
      { url: "https://EXAMPLE.com/post/", title: "A", popularity: [hatena] },
    ];

    const merged = mergeCandidates(candidates);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toBe("https://example.com/post");
    expect(merged[0]?.popularity).toEqual([hn, hatena]);
  });

  it("異なる URL の候補はそのまま残す", () => {
    const candidates: Candidate[] = [
      { url: "https://example.com/a", title: "A", popularity: [] },
      { url: "https://example.com/b", title: "B", popularity: [] },
    ];

    expect(mergeCandidates(candidates)).toHaveLength(2);
  });

  it("空配列には空配列を返す", () => {
    expect(mergeCandidates([])).toEqual([]);
  });
});
