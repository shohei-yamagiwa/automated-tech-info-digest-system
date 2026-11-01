import * as cheerio from "cheerio";
import Parser from "rss-parser";
import type { Source } from "../config/config.js";
import type { Candidate } from "./dedupe.js";

export type CollectContext = {
  fetch: typeof fetch;
  since: Date;
  qiitaToken?: string;
};

const QIITA_PER_PAGE = 100;
const QIITA_MAX_PAGE = 100;

type FeedItem = { "hatena:bookmarkcount"?: string; "dc:date"?: string };

const feedParser = new Parser<unknown, FeedItem>({
  customFields: { item: ["hatena:bookmarkcount", "dc:date"] },
});

async function fetchText(
  context: CollectContext,
  url: string,
  init?: RequestInit,
): Promise<string> {
  const response = await context.fetch(url, init);
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response.text();
}

async function collectFeed(
  context: CollectContext,
  url: string,
  popularityOf: (item: FeedItem) => Candidate["popularity"] = () => [],
): Promise<Candidate[]> {
  const feed = await feedParser.parseString(await fetchText(context, url));
  const candidates: Candidate[] = [];
  for (const item of feed.items) {
    const published = item.isoDate ?? item["dc:date"];
    if (published !== undefined && new Date(published) < context.since) continue;
    if (!item.link || !item.title) continue;
    candidates.push({
      url: item.link,
      title: item.title,
      summary: item.contentSnippet ?? item.summary ?? item.content,
      popularity: popularityOf(item),
    });
  }
  return candidates;
}

async function collectHackerNews(
  context: CollectContext,
  minPoints: number,
): Promise<Candidate[]> {
  const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
  url.searchParams.set("tags", "story");
  url.searchParams.set(
    "numericFilters",
    `created_at_i>${Math.floor(context.since.getTime() / 1000)},points>${minPoints}`,
  );
  url.searchParams.set("hitsPerPage", "1000");

  const body = JSON.parse(await fetchText(context, url.toString())) as {
    hits: Array<{
      title: string;
      url: string | null;
      points: number;
      num_comments: number;
    }>;
  };
  return body.hits.flatMap((hit) =>
    hit.url
      ? [
          {
            url: hit.url,
            title: hit.title,
            popularity: [
              { source: "hackernews", name: "points", value: hit.points },
              { source: "hackernews", name: "comments", value: hit.num_comments },
            ],
          },
        ]
      : [],
  );
}

async function collectGithubTrending(context: CollectContext): Promise<Candidate[]> {
  const $ = cheerio.load(await fetchText(context, "https://github.com/trending"));
  const candidates: Candidate[] = [];
  $("article.Box-row").each((_, element) => {
    const article = $(element);
    const path = article.find("h2 a").attr("href")?.replace(/^\//, "");
    const stars = /([\d,]+)\s+stars?\s+today/.exec(article.text())?.[1];
    if (!path) return;
    candidates.push({
      url: `https://github.com/${path}`,
      title: path,
      summary: article.find("p").first().text().trim() || undefined,
      popularity:
        stars === undefined
          ? []
          : [
              {
                source: "github-trending",
                name: "stars-today",
                value: Number(stars.replaceAll(",", "")),
              },
            ],
    });
  });
  if (candidates.length === 0) {
    throw new Error("GitHub Trending: no repositories found in the page");
  }
  return candidates;
}

async function collectQiita(
  context: CollectContext,
  minStocks: number,
): Promise<Candidate[]> {
  if (!context.qiitaToken) throw new Error("QIITA_TOKEN is not set");

  const query = `created:>=${context.since.toISOString().slice(0, 10)} stocks:>${minStocks}`;
  const candidates: Candidate[] = [];
  for (let page = 1; page <= QIITA_MAX_PAGE; page++) {
    const url = new URL("https://qiita.com/api/v2/items");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(QIITA_PER_PAGE));
    url.searchParams.set("query", query);
    const items = JSON.parse(
      await fetchText(context, url.toString(), {
        headers: { Authorization: `Bearer ${context.qiitaToken}` },
      }),
    ) as Array<{
      title: string;
      url: string;
      created_at: string;
      likes_count: number;
      stocks_count: number;
      tags: Array<{ name: string }>;
    }>;

    for (const item of items) {
      if (new Date(item.created_at) < context.since) continue;
      candidates.push({
        url: item.url,
        title: item.title,
        summary: item.tags.map((tag) => tag.name).join(", ") || undefined,
        popularity: [
          { source: "qiita", name: "likes", value: item.likes_count },
          { source: "qiita", name: "stocks", value: item.stocks_count },
        ],
      });
    }
    if (items.length < QIITA_PER_PAGE) break;
  }
  return candidates;
}

export async function collectFromSource(
  source: Source,
  context: CollectContext,
): Promise<Candidate[]> {
  switch (source.type) {
    case "rss":
      return collectFeed(context, source.url);
    case "hackernews":
      return collectHackerNews(context, source.minPoints);
    case "github-trending":
      return collectGithubTrending(context);
    case "hatena-hotentry":
      return collectFeed(context, "https://b.hatena.ne.jp/hotentry/it.rss", (item) => [
        {
          source: "hatena",
          name: "bookmarks",
          value: Number(item["hatena:bookmarkcount"]),
        },
      ]);
    case "zenn": {
      const urls = [
        "https://zenn.dev/feed",
        ...source.topics.map((topic) => `https://zenn.dev/topics/${topic}/feed`),
      ];
      const candidates: Candidate[] = [];
      for (const url of urls) candidates.push(...(await collectFeed(context, url)));
      return candidates;
    }
    case "qiita":
      return collectQiita(context, source.minStocks);
  }
}
