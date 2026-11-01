import { describe, expect, it } from "vitest";
import type { Candidate } from "./dedupe.js";
import { excludeSeen } from "./exclude-seen.js";

const candidate = (url: string): Candidate => ({ url, title: url, popularity: [] });

describe("excludeSeen", () => {
  it("掲載済みの URL を持つ候補を除外する", () => {
    const result = excludeSeen(
      [candidate("https://example.com/a"), candidate("https://example.com/b")],
      ["https://example.com/a"],
    );

    expect(result.map((c) => c.url)).toEqual(["https://example.com/b"]);
  });

  it("表記ゆれがあっても同じ URL として除外する", () => {
    const result = excludeSeen(
      [candidate("https://example.com/a")],
      ["https://EXAMPLE.com/a/?utm_source=rss"],
    );

    expect(result).toEqual([]);
  });

  it("掲載済み URL が空なら候補をそのまま返す", () => {
    const candidates = [candidate("https://example.com/a")];

    expect(excludeSeen(candidates, [])).toEqual(candidates);
  });

  it("掲載済み URL に不正な文字列があればエラーにする", () => {
    expect(() => excludeSeen([], ["not a url"])).toThrow();
  });
});
