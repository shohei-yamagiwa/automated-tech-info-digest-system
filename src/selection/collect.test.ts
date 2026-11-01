import { describe, expect, it } from "vitest";
import { fakeFetch } from "../test-support/fake-fetch.js";
import { collectFromSource } from "./collect.js";

const since = new Date("2026-10-31T00:00:00Z");

const rss = (...items: Array<{ title: string; link: string; description: string; date: string }>) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title><link>https://example.com</link><description>d</description>
${items
  .map(
    (i) =>
      `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description}</description><pubDate>${i.date}</pubDate></item>`,
  )
  .join("\n")}
</channel></rss>`;

describe("collectFromSource: rss", () => {
  const feed = rss(
    {
      title: "New post",
      link: "https://example.com/new",
      description: "summary new",
      date: "Sat, 31 Oct 2026 10:00:00 GMT",
    },
    {
      title: "Old post",
      link: "https://example.com/old",
      description: "summary old",
      date: "Mon, 01 Jan 2024 10:00:00 GMT",
    },
  );

  it("前回実行以降の記事だけを、タイトル・URL・概要つきで返す", async () => {
    const { fetch } = fakeFetch({ "https://example.com/feed.xml": feed });

    const result = await collectFromSource(
      { type: "rss", name: "Blog", url: "https://example.com/feed.xml" },
      { fetch, since },
    );

    expect(result).toEqual([
      {
        url: "https://example.com/new",
        title: "New post",
        summary: "summary new",
        popularity: [],
      },
    ]);
  });

  it("取得に失敗したらエラーにする", async () => {
    const { fetch } = fakeFetch({
      "https://example.com/feed.xml": { status: 500, body: "" },
    });

    await expect(
      collectFromSource(
        { type: "rss", name: "Blog", url: "https://example.com/feed.xml" },
        { fetch, since },
      ),
    ).rejects.toThrow();
  });
});

describe("collectFromSource: hackernews", () => {
  const body = JSON.stringify({
    nbPages: 1,
    hits: [
      {
        objectID: "1",
        title: "Show HN: Tool",
        url: "https://example.com/hn",
        points: 320,
        num_comments: 45,
      },
      { objectID: "2", title: "Ask HN: Something", url: null, points: 200, num_comments: 10 },
    ],
  });

  it("points と コメント数を人気度に持つ候補を返し、外部 URL のない投稿は除く", async () => {
    const { fetch } = fakeFetch({ "hn.algolia.com": body });

    const result = await collectFromSource(
      { type: "hackernews", minPoints: 100 },
      { fetch, since },
    );

    expect(result).toEqual([
      {
        url: "https://example.com/hn",
        title: "Show HN: Tool",
        popularity: [
          { source: "hackernews", name: "points", value: 320 },
          { source: "hackernews", name: "comments", value: 45 },
        ],
      },
    ]);
  });

  it("前回実行以降・指定 points 超の条件を URL エンコードして送る", async () => {
    const { fetch, calls } = fakeFetch({ "hn.algolia.com": body });

    await collectFromSource({ type: "hackernews", minPoints: 100 }, { fetch, since });

    const url = calls[0]!.url;
    expect(url).not.toContain(">");
    expect(new URL(url).searchParams.get("numericFilters")).toBe(
      `created_at_i>${since.getTime() / 1000},points>100`,
    );
  });

  it("取得に失敗したらエラーにする", async () => {
    const { fetch } = fakeFetch({ "hn.algolia.com": { status: 500, body: "" } });

    await expect(
      collectFromSource({ type: "hackernews", minPoints: 100 }, { fetch, since }),
    ).rejects.toThrow();
  });
});

describe("collectFromSource: github-trending", () => {
  const article = (repo: string, description: string, stars: string) => `
<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/${repo}" class="Link">
    <span class="text-normal">${repo.split("/")[0]} /</span>
    ${repo.split("/")[1]}
  </a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">${description}</p>
  <div class="f6 color-fg-muted mt-2"><span class="d-inline-block float-sm-right">${stars} stars today</span></div>
</article>`;

  it("リポジトリ名・説明・当日のスター数を持つ候補を返す", async () => {
    const html = `<html><body><main>${article("owner/repo", "A cool repo", "1,234")}${article("acme/lib", "Another", "56")}</main></body></html>`;
    const { fetch } = fakeFetch({ "https://github.com/trending": html });

    const result = await collectFromSource({ type: "github-trending" }, { fetch, since });

    expect(result).toEqual([
      {
        url: "https://github.com/owner/repo",
        title: "owner/repo",
        summary: "A cool repo",
        popularity: [{ source: "github-trending", name: "stars-today", value: 1234 }],
      },
      {
        url: "https://github.com/acme/lib",
        title: "acme/lib",
        summary: "Another",
        popularity: [{ source: "github-trending", name: "stars-today", value: 56 }],
      },
    ]);
  });

  it("リポジトリを解析できなければエラーにする", async () => {
    const { fetch } = fakeFetch({
      "https://github.com/trending": "<html><body>layout changed</body></html>",
    });

    await expect(
      collectFromSource({ type: "github-trending" }, { fetch, since }),
    ).rejects.toThrow();
  });
});

describe("collectFromSource: hatena-hotentry", () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
<channel rdf:about="https://b.hatena.ne.jp/hotentry/it"><title>t</title><link>https://b.hatena.ne.jp/hotentry/it</link><description>d</description></channel>
<item rdf:about="https://example.com/jp"><title>日本語の記事</title><link>https://example.com/jp</link><description>概要です</description><dc:date>2026-10-31T12:00:00Z</dc:date><hatena:bookmarkcount>150</hatena:bookmarkcount></item>
<item rdf:about="https://example.com/jp-old"><title>古い記事</title><link>https://example.com/jp-old</link><description>古い</description><dc:date>2024-01-01T12:00:00Z</dc:date><hatena:bookmarkcount>900</hatena:bookmarkcount></item>
</rdf:RDF>`;

  it("ブックマーク数を人気度に持つ、前回実行以降の候補を返す", async () => {
    const { fetch } = fakeFetch({ "https://b.hatena.ne.jp/hotentry/it.rss": feed });

    const result = await collectFromSource({ type: "hatena-hotentry" }, { fetch, since });

    expect(result).toEqual([
      {
        url: "https://example.com/jp",
        title: "日本語の記事",
        summary: "概要です",
        popularity: [{ source: "hatena", name: "bookmarks", value: 150 }],
      },
    ]);
  });
});

describe("collectFromSource: zenn", () => {
  it("トレンドとトピック別のフィードを両方取得する", async () => {
    const trend = rss({
      title: "Trend",
      link: "https://zenn.dev/a/articles/trend",
      description: "t",
      date: "Sat, 31 Oct 2026 10:00:00 GMT",
    });
    const topic = rss({
      title: "Topic",
      link: "https://zenn.dev/b/articles/topic",
      description: "p",
      date: "Sat, 31 Oct 2026 11:00:00 GMT",
    });
    const { fetch, calls } = fakeFetch({
      "https://zenn.dev/feed": trend,
      "https://zenn.dev/topics/typescript/feed": topic,
    });

    const result = await collectFromSource(
      { type: "zenn", topics: ["typescript"] },
      { fetch, since },
    );

    expect(calls.map((c) => c.url)).toEqual([
      "https://zenn.dev/feed",
      "https://zenn.dev/topics/typescript/feed",
    ]);
    expect(result.map((c) => c.title)).toEqual(["Trend", "Topic"]);
  });
});

describe("collectFromSource: qiita", () => {
  const body = JSON.stringify([
    {
      id: "abc",
      title: "Qiita の記事",
      url: "https://qiita.com/u/items/abc",
      created_at: "2026-10-31T09:00:00+09:00",
      likes_count: 30,
      stocks_count: 12,
      tags: [{ name: "TypeScript" }],
    },
  ]);

  it("アクセストークンつきで取得し、いいね数とストック数を人気度に持つ候補を返す", async () => {
    const { fetch, calls } = fakeFetch({ "https://qiita.com/api/v2/items": body });

    const result = await collectFromSource(
      { type: "qiita", minStocks: 3 },
      { fetch, since, qiitaToken: "tok" },
    );

    expect(result).toMatchObject([
      {
        url: "https://qiita.com/u/items/abc",
        title: "Qiita の記事",
        popularity: [
          { source: "qiita", name: "likes", value: 30 },
          { source: "qiita", name: "stocks", value: 12 },
        ],
      },
    ]);
    expect((calls[0]!.init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok",
    );
    const query = new URL(calls[0]!.url).searchParams.get("query");
    expect(query).toContain("created:>=2026-10-31");
    expect(query).toContain("stocks:>3");
  });

  it("アクセストークンがなければエラーにする", async () => {
    const { fetch } = fakeFetch({ "https://qiita.com/api/v2/items": body });

    await expect(collectFromSource({ type: "qiita", minStocks: 3 }, { fetch, since })).rejects.toThrow();
  });
});
