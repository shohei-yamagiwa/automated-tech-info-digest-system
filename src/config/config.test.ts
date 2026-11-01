import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInterests, parseSettings, parseSources } from "./config.js";

const readConfig = (name: string) =>
  readFileSync(new URL(`../../config/${name}`, import.meta.url), "utf-8");

describe("parseInterests", () => {
  it("関心領域の一覧を読み込み、重みを省略した場合は 1 にする", () => {
    const interests = parseInterests(`
interests:
  - name: AI/LLM
    description: LLM の新モデルや活用手法
    weight: 1.5
  - name: 形式手法
    description: 仕様記述や検証
`);

    expect(interests).toEqual([
      { name: "AI/LLM", description: "LLM の新モデルや活用手法", weight: 1.5 },
      { name: "形式手法", description: "仕様記述や検証", weight: 1 },
    ]);
  });

  it("分野名が重複していればエラーにする", () => {
    expect(() =>
      parseInterests(`
interests:
  - { name: AI, description: a }
  - { name: AI, description: b }
`),
    ).toThrow();
  });

  it("関心領域が空ならエラーにする", () => {
    expect(() => parseInterests("interests: []")).toThrow();
  });

  it("重みが 0 以下ならエラーにする", () => {
    expect(() =>
      parseInterests("interests:\n  - { name: AI, description: a, weight: 0 }"),
    ).toThrow();
  });

  it("YAML として不正ならエラーにする", () => {
    expect(() => parseInterests("interests: [")).toThrow();
  });

  it("リポジトリの config/interests.yaml が有効である", () => {
    expect(parseInterests(readConfig("interests.yaml")).length).toBeGreaterThan(0);
  });
});

describe("parseSources", () => {
  it("種類ごとの情報源を読み込み、省略可能な値には既定値を入れる", () => {
    const sources = parseSources(`
sources:
  - { type: rss, name: Example Blog, url: "https://example.com/feed.xml" }
  - { type: hackernews }
  - { type: github-trending }
  - { type: hatena-hotentry }
  - { type: zenn, topics: [typescript] }
  - { type: qiita }
`);

    expect(sources).toEqual([
      { type: "rss", name: "Example Blog", url: "https://example.com/feed.xml" },
      { type: "hackernews", minPoints: 100 },
      { type: "github-trending" },
      { type: "hatena-hotentry" },
      { type: "zenn", topics: ["typescript"] },
      { type: "qiita", minStocks: 3 },
    ]);
  });

  it("未知の種類の情報源はエラーにする", () => {
    expect(() => parseSources("sources:\n  - { type: techfeed }")).toThrow();
  });

  it("RSS の URL が欠けていればエラーにする", () => {
    expect(() => parseSources("sources:\n  - { type: rss, name: X }")).toThrow();
  });

  it("リポジトリの config/sources.yaml が有効である", () => {
    expect(parseSources(readConfig("sources.yaml")).length).toBeGreaterThan(0);
  });
});

describe("parseSettings", () => {
  it("空の設定には既定値を入れる", () => {
    expect(parseSettings("{}")).toEqual({
      selection: { count: 10, maxPerDomain: 4 },
      scoring: { popularityStrength: 10 },
      models: { relevance: "claude-sonnet-5-5", summarize: "claude-opus-5-5" },
      slides: { numCards: 25 },
    });
  });

  it("指定した値で既定値を上書きする", () => {
    const settings = parseSettings(`
selection:
  count: 5
slides:
  numCards: 15
`);

    expect(settings.selection).toEqual({ count: 5, maxPerDomain: 4 });
    expect(settings.slides.numCards).toBe(15);
  });

  it("掲載本数が 1 未満ならエラーにする", () => {
    expect(() => parseSettings("selection:\n  count: 0")).toThrow();
  });

  it("未知のキーはタイポの可能性があるためエラーにする", () => {
    expect(() => parseSettings("selection:\n  maxPerDomein: 3")).toThrow();
  });

  it("リポジトリの config/settings.yaml が有効である", () => {
    expect(() => parseSettings(readConfig("settings.yaml"))).not.toThrow();
  });
});
