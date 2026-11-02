import type Anthropic from "@anthropic-ai/sdk";
import type { drive_v3 } from "googleapis";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, type Deps } from "./main.js";

const NOW = new Date("2026-11-02T22:10:00Z");
const TODAY = "2026-11-03";
const SINCE_DEFAULT = "2026-11-01T22:10:00.000Z";
const WEBHOOK = "https://discord.example/hook";
const EXPORT_URL = "https://exports.example/secret-token/slides.pdf";
const DAY_PATH = ["TechDigest", "2026", "11", "03"];

const INTERESTS_YAML = `interests:
  - { name: AI/LLM, description: llm, weight: 1 }
  - { name: Web, description: web, weight: 0.5 }
`;
const SETTINGS_YAML = `selection: { count: 10, maxPerDomain: 4 }
scoring: { popularityStrength: 10 }
models: { relevance: r, summarize: s }
slides: { numCards: 25 }
`;
const RSS_SOURCE = 'sources:\n  - { type: rss, name: A, url: "https://a.example/feed" }\n';

type Message = { stop_reason: string; stop_details?: { category: string } | null; parsed_output: unknown };
type StreamParams = {
  model: string;
  system: string;
  messages: { content: string }[];
  output_config: { effort: string; format: unknown };
  thinking: unknown;
  betas: string[];
  fallbacks: unknown;
};

const xml = (value: string) => value.replaceAll("&", "&amp;");

function rss(items: { title: string; link: string; date?: string; description?: string }[]) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><link>${xml(i.link)}</link>${
          i.date ? `<pubDate>${new Date(i.date).toUTCString()}</pubDate>` : ""
        }${i.description ? `<description>${i.description}</description>` : ""}</item>`,
    )
    .join("")}</channel></rss>`;
}

function hatenaRss(items: { title: string; link: string; date: string; bookmarks: number }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
<channel rdf:about="https://b.hatena.ne.jp/hotentry/it"><title>hotentry</title><link>https://b.hatena.ne.jp/hotentry/it</link><description>d</description></channel>
${items
  .map(
    (i) =>
      `<item rdf:about="${xml(i.link)}"><title>${i.title}</title><link>${xml(i.link)}</link><dc:date>${i.date}</dc:date><hatena:bookmarkcount>${i.bookmarks}</hatena:bookmarkcount></item>`,
  )
  .join("\n")}
</rdf:RDF>`;
}

function trendingHtml(repos: { path: string; description: string; starsToday?: string }[]) {
  return `<html><body>${repos
    .map(
      (r) =>
        `<article class="Box-row"><h2><a href="/${r.path}">${r.path}</a></h2><p>${r.description}</p>${
          r.starsToday ? `<span>${r.starsToday} stars today</span>` : ""
        }</article>`,
    )
    .join("")}</body></html>`;
}

function fakeDrive() {
  type Entry = { id: string; name: string; mimeType: string; parent: string; content: Buffer };
  const entries: Entry[] = [];
  let nextId = 1;
  const failures = { list: 0, create: 0, update: 0, get: 0 };
  const failIfNeeded = (method: keyof typeof failures) => {
    if (failures[method] > 0) {
      failures[method]--;
      throw new Error(`fake drive ${method} failure`);
    }
  };
  const readBody = async (body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  };
  const drive = {
    files: {
      list: async (params: { q: string }) => {
        failIfNeeded("list");
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(params.q)![1]!.replace(/\\(.)/g, "$1");
        const parent = /'([^']+)' in parents/.exec(params.q)![1]!;
        const wantsFolder = params.q.includes("mimeType = 'application/vnd.google-apps.folder'");
        const excludesFolder = params.q.includes("mimeType != 'application/vnd.google-apps.folder'");
        const files = entries.filter(
          (e) =>
            e.name === name &&
            e.parent === parent &&
            (!wantsFolder || e.mimeType === "application/vnd.google-apps.folder") &&
            (!excludesFolder || e.mimeType !== "application/vnd.google-apps.folder"),
        );
        return { data: { files: files.map((f) => ({ id: f.id })) } };
      },
      create: async (params: {
        requestBody: { name: string; mimeType: string; parents: string[] };
        media?: { body: Readable };
      }) => {
        failIfNeeded("create");
        const id = `id${nextId++}`;
        entries.push({
          id,
          name: params.requestBody.name,
          mimeType: params.requestBody.mimeType,
          parent: params.requestBody.parents[0]!,
          content: params.media ? await readBody(params.media.body) : Buffer.alloc(0),
        });
        return { data: { id, webViewLink: `https://drive.example/${id}` } };
      },
      update: async (params: { fileId: string; media: { body: Readable } }) => {
        failIfNeeded("update");
        const entry = entries.find((e) => e.id === params.fileId)!;
        entry.content = await readBody(params.media.body);
        return { data: { id: entry.id, webViewLink: `https://drive.example/${entry.id}` } };
      },
      get: async (params: { fileId: string }) => {
        failIfNeeded("get");
        return { data: new Uint8Array(entries.find((e) => e.id === params.fileId)!.content).buffer };
      },
    },
  } as unknown as drive_v3.Drive;
  const find = (path: string[]) => {
    let parent = "root";
    let found: Entry | undefined;
    for (const name of path) {
      found = entries.find((e) => e.name === name && e.parent === parent);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  };
  const put = (path: string[], content: string | Buffer) => {
    let parent = "root";
    path.forEach((name, i) => {
      const isFile = i === path.length - 1;
      let entry = entries.find((e) => e.name === name && e.parent === parent);
      if (!entry) {
        entry = {
          id: `id${nextId++}`,
          name,
          mimeType: isFile ? "application/octet-stream" : "application/vnd.google-apps.folder",
          parent,
          content: Buffer.alloc(0),
        };
        entries.push(entry);
      }
      if (isFile) entry.content = Buffer.from(content);
      parent = entry.id;
    });
  };
  return { drive, entries, failures, find, put };
}

type Judge = (title: string, index: number) => Partial<{ relevance: number; domain: string; topic: string }>;

async function setup(
  options: {
    sources?: string;
    settings?: string;
    feed?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
    judge?: Judge;
    claude?: (params: StreamParams) => Message | Promise<Message>;
    gamma?: "ok" | "fail";
  } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), "digest-root-"));
  const outDir = await mkdtemp(join(tmpdir(), "digest-out-"));
  await mkdir(join(rootDir, "config"));
  await mkdir(join(rootDir, "prompts"));
  await writeFile(join(rootDir, "config/interests.yaml"), INTERESTS_YAML);
  await writeFile(join(rootDir, "config/sources.yaml"), options.sources ?? RSS_SOURCE);
  await writeFile(join(rootDir, "config/settings.yaml"), options.settings ?? SETTINGS_YAML);
  await writeFile(join(rootDir, "prompts/summarize.md"), "要約してください");

  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const custom = await options.feed?.(url, init);
    if (custom) return custom;
    if (url === "https://a.example/feed") {
      return new Response(
        rss([
          { title: "LLM news", link: "https://a.example/llm", date: "2026-11-02T10:00:00Z" },
          { title: "Web news", link: "https://a.example/web", date: "2026-11-02T11:00:00Z" },
        ]),
      );
    }
    if (url.startsWith("https://r.jina.ai/")) return new Response(`Title: x\n\nMarkdown Content:\nbody of ${url}`);
    if (url === "https://public-api.gamma.app/v1.0/generations" && init?.method === "POST") {
      return options.gamma === "fail"
        ? new Response("no credits", { status: 402 })
        : Response.json({ generationId: "gen1" });
    }
    if (url === "https://public-api.gamma.app/v1.0/generations/gen1") {
      return Response.json({
        status: "completed",
        gammaUrl: "https://gamma.app/docs/abc",
        exportUrl: EXPORT_URL,
        credits: { deducted: 40 },
      });
    }
    if (url === EXPORT_URL) return new Response(new Uint8Array([37, 80, 68, 70]));
    if (url === WEBHOOK) return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const claudeRequests: StreamParams[] = [];
  const judge = options.judge ?? (() => ({}));
  const anthropic = {
    beta: {
      messages: {
        stream: (params: StreamParams) => {
          claudeRequests.push(params);
          return {
            finalMessage: async (): Promise<Message> => {
              if (options.claude) return options.claude(params);
              const user = params.messages[0]!.content;
              if (params.system.includes("選定アシスタント")) {
                return {
                  stop_reason: "end_turn",
                  parsed_output: {
                    judgements: [...user.matchAll(/^\[(\d+)\] (.+)$/gm)].map(([, index, title]) => ({
                      index: Number(index),
                      relevance: 50,
                      domain: title!.startsWith("Web") ? "Web" : "AI/LLM",
                      topic: title!,
                      ...judge(title!, Number(index)),
                    })),
                  },
                };
              }
              if (params.system.includes("ダイジェストの編集者")) {
                return { stop_reason: "end_turn", parsed_output: { title: "  今日の見出し  " } };
              }
              const id = /# 記事のURL\n(\S+)/.exec(user)![1]!;
              return {
                stop_reason: "end_turn",
                parsed_output: {
                  title: `要約 ${id}`,
                  what: `what ${id}`,
                  why_it_matters: `why ${id}`,
                  key_points: [`point ${id}`],
                  caveats: [],
                },
              };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;

  const delays: number[] = [];
  const logs: string[] = [];
  const drive = fakeDrive();
  const deps = (overrides: Partial<Deps> = {}): Deps => ({
    now: NOW,
    fetch: fetchFn,
    sleep: async (ms) => {
      delays.push(ms);
    },
    anthropic,
    drive: drive.drive,
    rootDir,
    outDir,
    log: (message) => logs.push(message),
    ...overrides,
  });
  const env = { JINA_API_KEY: "jina", QIITA_TOKEN: "qiita-token", GAMMA_API_KEY: "gamma", DISCORD_WEBHOOK_URL: WEBHOOK };
  const dayDir = (date: string) => join(outDir, ...date.split("-"));
  const discordPosts = () =>
    calls.filter((c) => c.url === WEBHOOK).map((c) => (JSON.parse(c.init!.body as string) as { content: string }).content);
  const run = (argv: string[] = [], overrides: Partial<Deps> = {}, envOverride: Record<string, string | undefined> = env) =>
    main(argv, envOverride, deps(overrides));

  return { rootDir, outDir, calls, claudeRequests, delays, logs, drive, deps, env, dayDir, discordPosts, run };
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf-8"));

function selectionJson(
  specs: { id: string; score: number; domain?: string; topic?: string; selected?: boolean }[],
  date = TODAY,
) {
  const candidates = specs.map((s) => ({
    url: `https://a.example/${s.id}`,
    title: `Title ${s.id}`,
    relevance: Math.min(100, s.score),
    domain: s.domain ?? "AI/LLM",
    topic: s.topic ?? s.id,
    popularity: [],
    score: s.score,
    selected: s.selected ?? false,
    reason: "reason",
  }));
  return {
    date,
    since: SINCE_DEFAULT,
    until: NOW.toISOString(),
    totalCandidates: candidates.length,
    selected: candidates
      .filter((c) => c.selected)
      .map((c, i) => ({ rank: i + 1, url: c.url, title: c.title, score: c.score, domain: c.domain, topic: c.topic, popularity: [] })),
    candidates,
    failedSources: [{ source: "Qiita", message: "QIITA_TOKEN is not set" }],
  };
}

function articleJson(rank: number, domain: string, score: number, caveats: string[] = []) {
  return {
    rank,
    score,
    domain,
    url: `https://a.example/${rank}`,
    title: `記事${rank}`,
    what: `what${rank}`,
    why_it_matters: `why${rank}`,
    key_points: [`point${rank}-1`, `point${rank}-2`],
    caveats,
  };
}

function digestJson(overrides: Record<string, unknown> = {}) {
  return {
    date: TODAY,
    title: "今日の見出し",
    totalCandidates: 312,
    articles: [
      articleJson(1, "Web", 95),
      articleJson(2, "AI/LLM", 90, ["注意点"]),
      articleJson(3, "AI/LLM", 85),
      articleJson(4, "Unlisted", 80),
      articleJson(5, "Web", 70),
    ],
    failedSources: [],
    failedArticles: [],
    ...overrides,
  };
}

async function writeDay(t: Awaited<ReturnType<typeof setup>>, files: Record<string, unknown>, date = TODAY) {
  await mkdir(t.dayDir(date), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(t.dayDir(date), name), JSON.stringify(value));
  }
}

describe("引数と事前検証", () => {
  it("rejects unknown arguments and steps", async () => {
    const t = await setup();
    await expect(t.run(["--verbose"])).rejects.toThrow("Unknown argument: --verbose");
    await expect(t.run(["--from=publish"])).rejects.toThrow("--from must be one of select, summarize, slides, deliver");
  });

  it("defaults to dry-run and today's date in JST", async () => {
    const t = await setup();
    const result = await t.run();
    expect(result.date).toBe(TODAY);
    expect(result.slidesError).toBe("dry-run のためスライドを生成していません");
    expect(t.calls.some((c) => c.url === WEBHOOK || c.url.includes("gamma"))).toBe(false);
    expect(t.drive.entries).toHaveLength(0);
  });

  it("treats an empty --date as today", async () => {
    const t = await setup();
    expect((await t.run(["--date="])).date).toBe(TODAY);
  });

  it("rejects an invalid or future date", async () => {
    const t = await setup();
    await expect(t.run(["--date=2026-02-30"])).rejects.toThrow("Invalid date: 2026-02-30");
    await expect(t.run(["--date=20261103"])).rejects.toThrow("Invalid date");
    await expect(t.run(["--date=2026-11-04"])).rejects.toThrow("Date must not be in the future");
  });

  it("requires DISCORD_WEBHOOK_URL unless dry-run", async () => {
    const t = await setup();
    await expect(t.run(["--no-dry-run"], {}, { ...t.env, DISCORD_WEBHOOK_URL: undefined })).rejects.toThrow(
      "DISCORD_WEBHOOK_URL is required unless dry-run",
    );
  });

  it("requires Google credentials unless dry-run and notifies the failure", async () => {
    const t = await setup();
    await expect(t.run(["--no-dry-run"], { drive: undefined })).rejects.toThrow(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required unless dry-run",
    );
    expect(t.discordPosts()[0]).toContain("工程: 開始前の検証");
  });

  it("rejects invalid config files", async () => {
    const cases: [string, string][] = [
      ["config/settings.yaml", "selection: { count: 0, maxPerDomain: 4 }\n"],
      ["config/interests.yaml", "interests:\n  - { name: A, description: d, weight: 1 }\n  - { name: A, description: d, weight: 1 }\n"],
      ["config/interests.yaml", "interests:\n  - { name: A, description: d, weight: 0 }\n"],
      ["config/sources.yaml", "sources:\n  - { type: techfeed }\n"],
      ["config/sources.yaml", "sources:\n  - { type: rss, name: A, url: not-a-url }\n"],
      ["config/sources.yaml", "sources:\n  - { type: zenn, topics: [a/b] }\n"],
      ["config/sources.yaml", "sources:\n  - { type: github-trending, language: ts }\n"],
      ["config/sources.yaml", "sources: []\n"],
      ["prompts/summarize.md", "  \n"],
    ];
    for (const [path, content] of cases) {
      const t = await setup();
      await writeFile(join(t.rootDir, path), content);
      await expect(t.run(), `${path}: ${content}`).rejects.toThrow();
    }
  });

  it("accepts the config files in the repository", async () => {
    const t = await setup({ judge: () => ({ domain: "AI/LLM" }) });
    for (const path of ["config/interests.yaml", "config/sources.yaml", "config/settings.yaml", "prompts/summarize.md"]) {
      await writeFile(join(t.rootDir, path), readFileSync(path, "utf-8"));
    }
    await writeFile(join(t.rootDir, "config/sources.yaml"), RSS_SOURCE);
    await expect(t.run()).resolves.toBeDefined();
  });

  it("accepts themeId and folderId in settings and sends them to Gamma", async () => {
    const t = await setup({
      settings: SETTINGS_YAML.replace("slides: { numCards: 25 }", "slides: { numCards: 30, themeId: theme, folderId: folder }"),
    });
    await t.run();
    expect(await readJson(join(t.dayDir(TODAY), "gamma-request.json"))).toMatchObject({
      themeId: "theme",
      folderId: "folder",
      numCards: 30,
    });
  });
});

describe("① 収集", () => {
  it("collects RSS items published at or after since and keeps undated items", async () => {
    const t = await setup({
      feed: (url) =>
        url === "https://a.example/feed"
          ? new Response(
              rss([
                { title: "New", link: "https://a.example/new", date: "2026-11-02T00:00:00Z", description: "summary" },
                { title: "Old", link: "https://a.example/old", date: "2026-11-01T00:00:00Z" },
                { title: "Undated", link: "https://a.example/undated" },
              ]),
            )
          : undefined,
    });
    const { selection } = await t.run();
    expect(selection.candidates.map((c) => c.title).sort()).toEqual(["New", "Undated"]);
    expect(selection.since).toBe(SINCE_DEFAULT);
    expect(selection.until).toBe(NOW.toISOString());
  });

  it("queries Hacker News with URL-encoded numericFilters and keeps points and comments", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: hackernews }\n",
      feed: (url) =>
        url.includes("algolia")
          ? Response.json({
              hits: [
                { title: "Story", url: "https://b.example/story", points: 300, num_comments: 40 },
                { title: "Ask HN", url: null, points: 500, num_comments: 10 },
              ],
            })
          : undefined,
    });
    const { selection } = await t.run();
    const sinceSeconds = Math.floor(Date.parse(SINCE_DEFAULT) / 1000);
    expect(t.calls[0]!.url).toContain(`numericFilters=created_at_i%3E${sinceSeconds}%2Cpoints%3E100`);
    expect(t.calls[0]!.url).toContain("tags=story");
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]!.popularity).toEqual([
      { source: "hackernews", name: "points", value: 300 },
      { source: "hackernews", name: "comments", value: 40 },
    ]);
  });

  it("parses GitHub Trending and keeps today's stars", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: github-trending }\n",
      feed: (url) =>
        url.includes("github.com/trending")
          ? new Response(
              trendingHtml([
                { path: "owner/repo", description: "A repo", starsToday: "1,234" },
                { path: "owner/no-stars", description: "No stars" },
              ]),
            )
          : undefined,
    });
    const { selection } = await t.run();
    const repo = selection.candidates.find((c) => c.title === "owner/repo")!;
    expect(repo.url).toBe("https://github.com/owner/repo");
    expect(repo.popularity).toEqual([{ source: "github-trending", name: "stars-today", value: 1234 }]);
    expect(selection.candidates.find((c) => c.title === "owner/no-stars")!.popularity).toEqual([]);
  });

  it("skips GitHub Trending as a failed source when no repository can be parsed", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: github-trending }\n`,
      feed: (url) => (url.includes("github.com") ? new Response("<html><body>changed layout</body></html>") : undefined),
    });
    const { selection, digest } = await t.run();
    expect(selection.failedSources).toEqual([
      { source: "GitHub Trending", message: "GitHub Trending: no repositories found in the page" },
    ]);
    expect(digest.failedSources).toEqual(selection.failedSources);
  });

  it("reads bookmark counts from the Hatena hot entry feed", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: hatena-hotentry }\n",
      feed: (url) =>
        url === "https://b.hatena.ne.jp/hotentry/it.rss"
          ? new Response(hatenaRss([{ title: "Hatena", link: "https://c.example/x", date: "2026-11-02T09:00:00+09:00", bookmarks: 250 }]))
          : undefined,
    });
    const { selection } = await t.run();
    expect(selection.candidates[0]!.popularity).toEqual([{ source: "hatena", name: "bookmarks", value: 250 }]);
  });

  it("waits at least the Hatena crawl delay (5s) between retries", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: hatena-hotentry }\n`,
      feed: (url) => (url.includes("hatena") ? new Response("error", { status: 503 }) : undefined),
    });
    const { selection } = await t.run();
    expect(t.delays).toEqual([5000, 5000, 8000]);
    expect(selection.failedSources[0]!.source).toBe("はてなブックマーク");
  });

  it("retries a failing source with 2s, 4s and 8s intervals (4 attempts in total)", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: rss, name: Broken, url: "https://broken.example/feed" }\n`,
      feed: (url) => (url.includes("broken") ? new Response("error", { status: 500 }) : undefined),
    });
    const { selection } = await t.run();
    expect(t.calls.filter((c) => c.url.includes("broken"))).toHaveLength(4);
    expect(t.delays).toEqual([2000, 4000, 8000]);
    expect(selection.failedSources).toEqual([
      { source: "Broken", message: "GET https://broken.example/feed failed: HTTP 500" },
    ]);
  });

  it("recovers when a retry succeeds", async () => {
    let attempts = 0;
    const t = await setup({
      feed: (url) => (url === "https://a.example/feed" && attempts++ < 2 ? new Response("error", { status: 500 }) : undefined),
    });
    const { selection } = await t.run();
    expect(selection.failedSources).toEqual([]);
    expect(selection.candidates).toHaveLength(2);
  });

  it("fetches the Zenn trend feed and topic feeds, recording a failing topic feed separately", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: zenn, topics: [typescript, llm] }\n",
      feed: (url) => {
        if (url === "https://zenn.dev/topics/llm/feed") return new Response("error", { status: 500 });
        if (url === "https://zenn.dev/feed") return new Response(rss([{ title: "Trend", link: "https://zenn.dev/a/articles/1" }]));
        if (url === "https://zenn.dev/topics/typescript/feed") {
          return new Response(rss([{ title: "TS", link: "https://zenn.dev/b/articles/2" }]));
        }
        return undefined;
      },
    });
    const { selection } = await t.run();
    expect(selection.candidates.map((c) => c.title).sort()).toEqual(["TS", "Trend"]);
    expect(selection.failedSources.map((f) => f.source)).toEqual(["Zenn (llm)"]);
  });

  it("queries Qiita with the token, JST date and stock threshold, paging until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      title: `Q${i}`,
      url: `https://qiita.com/u/items/${i}`,
      body: "body",
      created_at: "2026-11-02T10:00:00+09:00",
      likes_count: i,
      stocks_count: i,
    }));
    const lastPage = [
      { title: "Old", url: "https://qiita.com/u/items/old", body: "", created_at: "2026-11-02T06:00:00+09:00", likes_count: 1, stocks_count: 1 },
    ];
    const t = await setup({
      sources: "sources:\n  - { type: qiita, minStocks: 3 }\n",
      feed: (url) =>
        url.startsWith("https://qiita.com/api")
          ? Response.json(new URL(url).searchParams.get("page") === "1" ? fullPage : lastPage)
          : undefined,
    });
    const { selection } = await t.run();
    const qiitaCalls = t.calls.filter((c) => c.url.startsWith("https://qiita.com/api"));
    expect(qiitaCalls).toHaveLength(2);
    expect(new URL(qiitaCalls[0]!.url).searchParams.get("query")).toBe("created:>=2026-11-02 stocks:>2");
    expect(new URL(qiitaCalls[1]!.url).searchParams.get("page")).toBe("2");
    expect((qiitaCalls[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer qiita-token");
    expect(selection.candidates).toHaveLength(100);
    expect(selection.candidates.find((c) => c.title === "Q5")!.popularity).toEqual([
      { source: "qiita", name: "likes", value: 5 },
      { source: "qiita", name: "stocks", value: 5 },
    ]);
  });

  it("omits the stock condition when minStocks is 0", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: qiita }\n`,
      feed: (url) => (url.startsWith("https://qiita.com/api") ? Response.json([]) : undefined),
    });
    await t.run();
    const qiita = t.calls.find((c) => c.url.startsWith("https://qiita.com/api"))!;
    expect(new URL(qiita.url).searchParams.get("query")).toBe("created:>=2026-11-02");
  });

  it("treats Qiita as a failed source when QIITA_TOKEN is missing", async () => {
    const t = await setup({ sources: `${RSS_SOURCE}  - { type: qiita, minStocks: 3 }\n` });
    const { selection } = await t.run([], {}, { ...t.env, QIITA_TOKEN: undefined });
    expect(selection.failedSources).toEqual([{ source: "Qiita", message: "QIITA_TOKEN is not set" }]);
    expect(t.calls.some((c) => c.url.includes("qiita"))).toBe(false);
  });

  it("treats malformed JSON from an API source as a failed source", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: hackernews }\n`,
      feed: (url) => (url.includes("algolia") ? new Response("<html>") : undefined),
    });
    const { selection } = await t.run();
    expect(selection.failedSources[0]!.source).toBe("Hacker News");
  });

  it("throws when every source fails", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: github-trending }\n`,
      feed: () => new Response("error", { status: 500 }),
    });
    await expect(t.run()).rejects.toThrow(/^All sources failed: A \(.*\); GitHub Trending \(.*\)$/);
  });
});

describe("① 重複統合と既出除外", () => {
  const twoSources = (hnUrl: string, hatenaUrl: string) =>
    setup({
      sources: "sources:\n  - { type: hackernews }\n  - { type: hatena-hotentry }\n",
      feed: (url) => {
        if (url.includes("algolia")) return Response.json({ hits: [{ title: "From HN", url: hnUrl, points: 200, num_comments: 5 }] });
        if (url.includes("hatena")) {
          return new Response(
            hatenaRss([{ title: "From Hatena", link: hatenaUrl, date: "2026-11-02T09:00:00+09:00", bookmarks: 80 }]),
          );
        }
        return undefined;
      },
    });

  it("merges the same article across sources after URL normalization and keeps every popularity signal", async () => {
    const t = await twoSources("https://www.example.com/post/?utm_source=hn&b=2&a=1#comments", "http://example.com/post?a=1&b=2");
    const { selection } = await t.run();
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]!.title).toBe("From HN");
    expect(selection.candidates[0]!.url).toBe("https://www.example.com/post/?utm_source=hn&b=2&a=1#comments");
    expect(selection.candidates[0]!.popularity).toEqual([
      { source: "hackernews", name: "points", value: 200 },
      { source: "hackernews", name: "comments", value: 5 },
      { source: "hatena", name: "bookmarks", value: 80 },
    ]);
  });

  it("does not merge URLs that differ in meaningful query parameters", async () => {
    const t = await twoSources("https://example.com/item?id=1", "https://example.com/item?id=2");
    expect((await t.run()).selection.candidates).toHaveLength(2);
  });

  it("fills in a missing summary from a duplicate", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: zenn, topics: [llm] }\n",
      feed: (url) => {
        if (url === "https://zenn.dev/feed") return new Response(rss([{ title: "Z", link: "https://zenn.dev/a/articles/1" }]));
        if (url.startsWith("https://zenn.dev/topics")) {
          return new Response(rss([{ title: "Z", link: "https://zenn.dev/a/articles/1", description: "topic summary" }]));
        }
        return undefined;
      },
    });
    const { selection } = await t.run();
    expect(selection.candidates).toHaveLength(1);
    expect(t.claudeRequests[0]!.messages[0]!.content).toBe("[0] Z\ntopic summary");
  });

  it("skips items whose URL is not http(s) or not parseable", async () => {
    const t = await setup({
      feed: (url) =>
        url === "https://a.example/feed"
          ? new Response(
              rss([
                { title: "Valid", link: "https://a.example/ok" },
                { title: "Ftp", link: "ftp://a.example/file" },
                { title: "Broken", link: "not a url" },
              ]),
            )
          : undefined,
    });
    expect((await t.run()).selection.candidates.map((c) => c.title)).toEqual(["Valid"]);
  });

  it("excludes URLs published on other days within 30 days after normalization", async () => {
    const t = await setup();
    await writeFile(
      join(t.outDir, "state.json"),
      JSON.stringify({
        runs: [],
        published: [
          { url: "http://www.a.example/llm/?utm_medium=rss", date: "2026-11-01" },
          { url: "https://a.example/web", date: "2026-10-01" },
        ],
      }),
    );
    const { selection, state } = await t.run();
    expect(selection.candidates.map((c) => c.url)).toEqual(["https://a.example/web"]);
    expect(state.published).toEqual([
      { url: "http://www.a.example/llm/?utm_medium=rss", date: "2026-11-01" },
      { url: "https://a.example/web", date: TODAY },
    ]);
  });

  it("throws without calling Claude when no candidate remains", async () => {
    const t = await setup();
    await writeFile(
      join(t.outDir, "state.json"),
      JSON.stringify({
        runs: [],
        published: [
          { url: "https://a.example/llm", date: "2026-11-02" },
          { url: "https://a.example/web", date: "2026-11-02" },
        ],
      }),
    );
    await expect(t.run()).rejects.toThrow("No candidates left");
    expect(t.claudeRequests).toHaveLength(0);
  });
});

describe("① 関連度判定", () => {
  it("asks the relevance model with interests, titles and summaries truncated to 500 characters", async () => {
    const t = await setup({
      feed: (url) =>
        url === "https://a.example/feed"
          ? new Response(rss([{ title: "Long", link: "https://a.example/long", description: "x".repeat(800) }]))
          : undefined,
    });
    await t.run();
    const request = t.claudeRequests[0]!;
    expect(request.model).toBe("r");
    expect(request.messages[0]!.content).toBe(`[0] Long\n${"x".repeat(500)}`);
    expect(request.system).toContain("- AI/LLM: llm");
    expect(request.system).toContain("- Web: web");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config.effort).toBe("high");
    expect(request.output_config.format).toBeDefined();
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(request.fallbacks).toBe("default");
  });

  it("retries when Claude does not judge every candidate exactly once", async () => {
    let calls = 0;
    const t = await setup({
      claude: (params) => {
        if (params.model !== "r") {
          return params.system.includes("ダイジェストの編集者")
            ? { stop_reason: "end_turn", parsed_output: { title: "t" } }
            : { stop_reason: "end_turn", parsed_output: { title: "s", what: "w", why_it_matters: "y", key_points: ["k"], caveats: [] } };
        }
        calls++;
        const judgement = (index: number) => ({ index, relevance: 10 * (index + 1), domain: "AI/LLM", topic: `t${index}` });
        if (calls === 1) return { stop_reason: "end_turn", parsed_output: { judgements: [judgement(0)] } };
        if (calls === 2) return { stop_reason: "end_turn", parsed_output: { judgements: [judgement(0), judgement(0)] } };
        return { stop_reason: "end_turn", parsed_output: { judgements: [judgement(0), judgement(1)] } };
      },
    });
    const { selection } = await t.run();
    expect(calls).toBe(3);
    expect(selection.candidates.map((c) => c.relevance).sort()).toEqual([10, 20]);
  });

  it.each([
    ["a domain outside interests", { domain: "Unknown" }],
    ["relevance over 100", { relevance: 120 }],
    ["an empty topic", { topic: "" }],
  ])("rejects %s and throws after 4 attempts", async (_label, judgement) => {
    const t = await setup({ judge: () => judgement });
    await expect(t.run()).rejects.toThrow();
    expect(t.claudeRequests.filter((r) => r.model === "r")).toHaveLength(4);
  });

  it.each([
    ["refusal", { stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null }, "Claude refused the request: cyber"],
    ["max_tokens", { stop_reason: "max_tokens", parsed_output: null }, "Claude hit max_tokens"],
  ])("treats %s as a failure", async (_label, message, error) => {
    const t = await setup({ claude: () => message });
    await expect(t.run()).rejects.toThrow(error);
    expect(t.claudeRequests).toHaveLength(4);
  });

  it("throws when Claude itself keeps failing", async () => {
    const t = await setup({
      claude: () => {
        throw new Error("overloaded");
      },
    });
    await expect(t.run()).rejects.toThrow("overloaded");
  });
});

describe("① スコア計算と上位選定", () => {
  const feedOf = (titles: string[]) => (url: string) =>
    url === "https://a.example/feed"
      ? new Response(rss(titles.map((title, i) => ({ title, link: `https://a.example/${i}` }))))
      : undefined;

  it("scores relevance × domain weight + strength × max popularity percentile within each source", async () => {
    const t = await setup({
      sources: `${RSS_SOURCE}  - { type: hackernews }\n`,
      feed: (url) =>
        url.includes("algolia")
          ? Response.json({
              hits: [
                { title: "HN low", url: "https://h.example/1", points: 100, num_comments: 90 },
                { title: "HN high", url: "https://h.example/2", points: 300, num_comments: 10 },
              ],
            })
          : feedOf(["Web plain"])(url),
      judge: (title) => (title === "Web plain" ? { relevance: 80, domain: "Web" } : { relevance: 60, domain: "AI/LLM" }),
    });
    const { selection } = await t.run();
    const scoreOf = (title: string) => selection.candidates.find((c) => c.title === title)!.score;
    expect(scoreOf("HN low")).toBeCloseTo(60 + 10 * 0.75);
    expect(scoreOf("HN high")).toBeCloseTo(60 + 10 * 0.75);
    expect(scoreOf("Web plain")).toBeCloseTo(80 * 0.5);
  });

  it("gives tied popularity values the same mid-rank percentile", async () => {
    const t = await setup({
      sources: "sources:\n  - { type: hackernews }\n",
      feed: (url) =>
        url.includes("algolia")
          ? Response.json({
              hits: [
                { title: "A", url: "https://h.example/a", points: 200, num_comments: 0 },
                { title: "B", url: "https://h.example/b", points: 200, num_comments: 0 },
              ],
            })
          : undefined,
    });
    expect((await t.run()).selection.candidates.map((c) => c.score)).toEqual([55, 55]);
  });

  it("selects only one article per topic and explains why the others were not selected", async () => {
    const t = await setup({
      feed: feedOf(["A2", "A1", "B"]),
      judge: (title) => ({ relevance: title === "A1" ? 90 : title === "A2" ? 80 : 70, topic: title.startsWith("A") ? "topic-a" : "topic-b" }),
    });
    const { selection } = await t.run();
    expect(selection.selected.map((s) => [s.rank, s.title])).toEqual([
      [1, "A1"],
      [2, "B"],
    ]);
    const a2 = selection.candidates.find((c) => c.title === "A2")!;
    expect(a2.selected).toBe(false);
    expect(a2.reason).toBe("同じ話題の記事「A1」が選定されたため");
    expect(selection.candidates.find((c) => c.title === "A1")!.reason).toBe("スコア上位1位として選定");
  });

  it("caps each domain at maxPerDomain and backfills with other domains", async () => {
    const t = await setup({
      settings: SETTINGS_YAML.replace("maxPerDomain: 4", "maxPerDomain: 2"),
      feed: feedOf(["L1", "L2", "L3", "Web1"]),
      judge: (title) => ({ relevance: { L1: 90, L2: 85, L3: 80, Web1: 50 }[title]! }),
    });
    const { selection } = await t.run();
    expect(selection.selected.map((s) => s.title)).toEqual(["L1", "L2", "Web1"]);
    expect(selection.candidates.find((c) => c.title === "L3")!.reason).toBe("分野「AI/LLM」の上限(2本)に達したため");
  });

  it("stops at count and keeps every candidate with its score and reason, sorted by score", async () => {
    const t = await setup({
      settings: SETTINGS_YAML.replace("count: 10", "count: 2"),
      feed: feedOf(["T0", "T1", "T2", "T3", "T4"]),
      judge: (_title, index) => ({ relevance: index * 10 }),
    });
    const { selection } = await t.run();
    expect(selection.selected.map((s) => s.title)).toEqual(["T4", "T3"]);
    expect(selection.totalCandidates).toBe(5);
    expect(selection.candidates.map((c) => c.title)).toEqual(["T4", "T3", "T2", "T1", "T0"]);
    expect(selection.candidates.find((c) => c.title === "T2")!.reason).toBe("スコアが上位2本に入らなかったため");
  });

  it("selects fewer than count when there are not enough candidates and saves selection.json", async () => {
    const t = await setup({ feed: feedOf(["Only"]) });
    const { selection } = await t.run();
    expect(selection.selected).toHaveLength(1);
    expect(await readJson(join(t.dayDir(TODAY), "selection.json"))).toEqual(selection);
    expect(t.logs).toContain("selection: 1 candidates, 1 selected");
  });
});

describe("② 要約", () => {
  const twoSelected = selectionJson([
    { id: "1", score: 90, selected: true },
    { id: "2", score: 80, selected: true },
  ]);

  it("fetches bodies via Jina Reader and summarizes each article with the summarize model and prompt", async () => {
    const t = await setup();
    await writeDay(t, { "selection.json": twoSelected });
    const { digest } = await t.run(["--from=summarize"]);

    const jina = t.calls.filter((c) => c.url.startsWith("https://r.jina.ai/"));
    expect(jina.map((c) => c.url)).toEqual(["https://r.jina.ai/https://a.example/1", "https://r.jina.ai/https://a.example/2"]);
    expect((jina[0]!.init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer jina");
    const summaryRequests = t.claudeRequests.filter((r) => r.system === "要約してください");
    expect(summaryRequests).toHaveLength(2);
    expect(summaryRequests.every((r) => r.model === "s")).toBe(true);
    expect(summaryRequests[0]!.messages[0]!.content).toBe(
      "# 記事のURL\nhttps://a.example/1\n\n# 元のタイトル\nTitle 1\n\n# 本文\nTitle: x\n\nMarkdown Content:\nbody of https://r.jina.ai/https://a.example/1",
    );
    expect(t.claudeRequests.filter((r) => r.model === "r")).toHaveLength(0);

    expect(digest).toEqual({
      date: TODAY,
      title: "今日の見出し",
      totalCandidates: 2,
      articles: [1, 2].map((rank) => ({
        title: `要約 https://a.example/${rank}`,
        what: `what https://a.example/${rank}`,
        why_it_matters: `why https://a.example/${rank}`,
        key_points: [`point https://a.example/${rank}`],
        caveats: [],
        rank,
        score: rank === 1 ? 90 : 80,
        domain: "AI/LLM",
        url: `https://a.example/${rank}`,
      })),
      failedSources: [{ source: "Qiita", message: "QIITA_TOKEN is not set" }],
      failedArticles: [],
    });
    expect(await readJson(join(t.dayDir(TODAY), "digest.json"))).toEqual(digest);
  });

  it("asks for the digest title after all summaries, using their titles and what", async () => {
    const t = await setup();
    await writeDay(t, { "selection.json": twoSelected });
    await t.run(["--from=summarize"]);
    const last = t.claudeRequests.at(-1)!;
    expect(last.system).toContain("ダイジェストの編集者");
    expect(last.model).toBe("s");
    expect(last.messages[0]!.content).toBe(
      "- 要約 https://a.example/1: what https://a.example/1\n- 要約 https://a.example/2: what https://a.example/2",
    );
  });

  it("retries Jina Reader with 2s, 4s and 8s intervals before giving up an article", async () => {
    const t = await setup({ feed: (url) => (url.endsWith("/2") ? new Response("error", { status: 500 }) : undefined) });
    await writeDay(t, { "selection.json": twoSelected });
    const { digest } = await t.run(["--from=summarize"]);
    expect(t.calls.filter((c) => c.url.endsWith("/2"))).toHaveLength(4);
    expect(t.delays).toEqual([2000, 4000, 8000]);
    expect(digest.articles.map((a) => a.url)).toEqual(["https://a.example/1"]);
    expect(digest.failedArticles).toEqual([
      { url: "https://a.example/2", title: "Title 2", message: "Jina Reader responded with HTTP 500" },
    ]);
  });

  it("promotes the best unselected candidate that respects topic and domain limits", async () => {
    const t = await setup({
      settings: SETTINGS_YAML.replace("maxPerDomain: 4", "maxPerDomain: 2"),
      feed: (url) => (url.endsWith("/3") || url.endsWith("/fallback-fails") ? new Response("error", { status: 500 }) : undefined),
    });
    await writeDay(t, {
      "selection.json": selectionJson([
        { id: "1", score: 90, selected: true, domain: "AI/LLM", topic: "t1" },
        { id: "2", score: 85, selected: true, domain: "AI/LLM", topic: "t2" },
        { id: "3", score: 80, selected: true, domain: "Web", topic: "t3" },
        { id: "same-topic", score: 79, topic: "t1" },
        { id: "domain-full", score: 78, domain: "AI/LLM", topic: "t4" },
        { id: "fallback-fails", score: 77, domain: "Web", topic: "t5" },
        { id: "fallback-ok", score: 76, domain: "Web", topic: "t6" },
        { id: "not-needed", score: 75, domain: "Web", topic: "t7" },
      ]),
    });
    const { digest } = await t.run(["--from=summarize"]);
    expect(digest.articles.map((a) => [a.rank, a.url, a.score, a.domain])).toEqual([
      [1, "https://a.example/1", 90, "AI/LLM"],
      [2, "https://a.example/2", 85, "AI/LLM"],
      [4, "https://a.example/fallback-ok", 76, "Web"],
    ]);
    expect(digest.failedArticles.map((f) => f.url)).toEqual(["https://a.example/3", "https://a.example/fallback-fails"]);
    for (const id of ["same-topic", "domain-full", "not-needed"]) {
      expect(t.calls.some((c) => c.url.endsWith(`/${id}`))).toBe(false);
    }
  });

  it("allows a fallback with the same topic as a failed article", async () => {
    const t = await setup({ feed: (url) => (url.endsWith("/1") ? new Response("error", { status: 500 }) : undefined) });
    await writeDay(t, {
      "selection.json": selectionJson([
        { id: "1", score: 90, selected: true, topic: "t1" },
        { id: "dup-of-1", score: 80, topic: "t1" },
      ]),
    });
    expect((await t.run(["--from=summarize"])).digest.articles.map((a) => a.url)).toEqual(["https://a.example/dup-of-1"]);
  });

  it("continues with fewer articles when no fallback is available", async () => {
    const t = await setup({ feed: (url) => (url.endsWith("/1") ? new Response("error", { status: 500 }) : undefined) });
    await writeDay(t, { "selection.json": twoSelected });
    expect((await t.run(["--from=summarize"])).digest.articles.map((a) => a.rank)).toEqual([2]);
  });

  it("treats a target error reported by Jina Reader and an empty body as failures", async () => {
    const t = await setup({
      feed: (url) => {
        if (url.endsWith("/1")) {
          return new Response("Title: Not Found\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nNot Found");
        }
        if (url.endsWith("/2")) return new Response("Title: x\n\nMarkdown Content:\n   ");
        if (url.endsWith("/3")) return new Response("plain body without header");
        return undefined;
      },
    });
    await writeDay(t, {
      "selection.json": selectionJson([
        { id: "1", score: 90, selected: true },
        { id: "2", score: 80, selected: true },
        { id: "3", score: 70, selected: true },
      ]),
    });
    const { digest } = await t.run(["--from=summarize"]);
    expect(digest.failedArticles.map((f) => f.message)).toEqual([
      "Target URL returned HTTP 404 via Jina Reader",
      "Jina Reader returned an empty body",
    ]);
    expect(digest.articles.map((a) => a.url)).toEqual(["https://a.example/3"]);
  });

  it("throws when no article body can be fetched", async () => {
    const t = await setup({ feed: (url) => (url.startsWith("https://r.jina.ai/") ? new Response("error", { status: 500 }) : undefined) });
    await writeDay(t, { "selection.json": twoSelected });
    await expect(t.run(["--from=summarize"])).rejects.toThrow(
      /^No article body could be fetched: https:\/\/a.example\/1 \(.*\); https:\/\/a.example\/2 \(.*\)$/,
    );
  });

  it("throws when nothing was selected or JINA_API_KEY is missing", async () => {
    const t = await setup();
    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 10 }]) });
    await expect(t.run(["--from=summarize"])).rejects.toThrow("No articles were selected");
    await writeDay(t, { "selection.json": twoSelected });
    await expect(t.run(["--from=summarize"], {}, { ...t.env, JINA_API_KEY: undefined })).rejects.toThrow("JINA_API_KEY is not set");
  });

  it("retries a summary that does not match the schema", async () => {
    let attempts = 0;
    const t = await setup({
      claude: (params) => {
        if (params.system.includes("ダイジェストの編集者")) return { stop_reason: "end_turn", parsed_output: { title: "t" } };
        if (params.messages[0]!.content.includes("Title 1") && attempts++ < 2) {
          return { stop_reason: "end_turn", parsed_output: { title: "missing fields" } };
        }
        return { stop_reason: "end_turn", parsed_output: { title: "s", what: "w", why_it_matters: "y", key_points: ["k"], caveats: [] } };
      },
    });
    await writeDay(t, { "selection.json": twoSelected });
    const { digest } = await t.run(["--from=summarize"]);
    expect(attempts).toBe(3);
    expect(digest.articles).toHaveLength(2);
  });

  it.each([
    ["empty key_points", { title: "s", what: "w", why_it_matters: "y", key_points: [], caveats: [] }],
    ["missing caveats", { title: "s", what: "w", why_it_matters: "y", key_points: ["k"] }],
    ["an extra field", { title: "s", what: "w", why_it_matters: "y", key_points: ["k"], caveats: [], domain: "x" }],
  ])("rejects a summary with %s", async (_label, output) => {
    const t = await setup({
      claude: (params) =>
        params.system.includes("ダイジェストの編集者")
          ? { stop_reason: "end_turn", parsed_output: { title: "t" } }
          : { stop_reason: "end_turn", parsed_output: output },
    });
    await writeDay(t, { "selection.json": twoSelected });
    await expect(t.run(["--from=summarize"])).rejects.toThrow();
  });

  it("throws when the digest title stays empty", async () => {
    const t = await setup({
      claude: (params) =>
        params.system.includes("ダイジェストの編集者")
          ? { stop_reason: "end_turn", parsed_output: { title: "   " } }
          : { stop_reason: "end_turn", parsed_output: { title: "s", what: "w", why_it_matters: "y", key_points: ["k"], caveats: [] } },
    });
    await writeDay(t, { "selection.json": twoSelected });
    await expect(t.run(["--from=summarize"])).rejects.toThrow("Claude returned an empty digest title");
  });
});

describe("③ スライド生成", () => {
  const gammaRequest = async (digest = digestJson(), settings?: string) => {
    const t = await setup(settings ? { settings } : {});
    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]), "digest.json": digest });
    await t.run(["--from=slides"]);
    return readJson(join(t.dayDir(TODAY), "gamma-request.json"));
  };

  it("uses the fixed Gamma parameters without themeId and folderId by default", async () => {
    const request = await gammaRequest();
    expect(request).toMatchObject({
      textMode: "generate",
      format: "presentation",
      numCards: 25,
      cardSplit: "auto",
      exportAs: "pdf",
    });
    expect(request.textOptions).toEqual({ language: "ja" });
    expect(request.imageOptions).toEqual({ source: "aiGenerated" });
    expect(request.cardOptions).toEqual({ dimensions: "16x9" });
    expect(request).not.toHaveProperty("themeId");
    expect(request).not.toHaveProperty("folderId");
    expect(request.additionalInstructions).toContain("原稿にない事実や数値を付け加えない");
    expect(request.additionalInstructions).toContain("元記事リンクを必ず残して");
    expect(request.additionalInstructions.length).toBeLessThanOrEqual(5000);
  });

  it("builds a cover with the title, top 3, domain breakdown, date and scale", async () => {
    const cover = (await gammaRequest()).inputText.split("---")[0];
    expect(cover).toContain("# 今日の見出し");
    expect(cover).toContain("2026年11月3日 / 312本の候補から5本を選定");
    expect(cover).toContain("## 注目3本\n\n- **記事1**: what1\n- **記事2**: what2\n- **記事3**: what3\n");
    expect(cover).toContain("AI/LLM 2・Web 2・Unlisted 1");
  });

  it("orders articles by the interests order, then by score within a domain", async () => {
    const { inputText } = await gammaRequest();
    expect([...inputText.matchAll(/^# (記事\d+)$/gm)].map((m) => m[1])).toEqual(["記事2", "記事3", "記事1", "記事5", "記事4"]);
  });

  it("writes each article with its domain, points, link and caveats only when present", async () => {
    const sections: string[] = (await gammaRequest()).inputText.split("\n---\n");
    const second = sections.find((s) => s.includes("# 記事2"))!;
    expect(second).toContain("分野: AI/LLM");
    expect(second).toContain("- point2-1\n- point2-2");
    expect(second).toContain("## 注意点・限界\n\n- 注意点");
    expect(second).toContain("元記事: https://a.example/2");
    expect(sections.find((s) => s.includes("# 記事3"))).not.toContain("注意点・限界");
  });

  it("throws when the input text exceeds Gamma's limit", async () => {
    const t = await setup();
    await writeDay(t, {
      "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]),
      "digest.json": digestJson({ articles: [{ ...articleJson(1, "Web", 1), what: "x".repeat(400_001) }] }),
    });
    await expect(t.run(["--from=slides"])).rejects.toThrow("Gamma inputText is too long");
  });

  const production = async (statuses: object[], options: { post?: Response; download?: Response; status?: Response } = {}) => {
    let poll = 0;
    const t = await setup({
      feed: (url, init) => {
        if (url.endsWith("/generations") && init?.method === "POST" && options.post) return options.post.clone();
        if (url.endsWith("/generations/gen1")) {
          if (options.status && poll === 0) {
            poll++;
            return options.status;
          }
          return Response.json(statuses[Math.min(poll++, statuses.length - 1)]);
        }
        if (url === EXPORT_URL && options.download) return options.download.clone();
        return undefined;
      },
    });
    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]), "digest.json": digestJson() });
    t.drive.put([...DAY_PATH, "selection.json"], JSON.stringify(selectionJson([{ id: "1", score: 90, selected: true }])));
    t.drive.put([...DAY_PATH, "digest.json"], JSON.stringify(digestJson()));
    const result = await t.run(["--no-dry-run", "--from=slides"]);
    return { t, result };
  };
  const completed = {
    status: "completed",
    gammaUrl: "https://gamma.app/docs/abc",
    exportUrl: EXPORT_URL,
    credits: { deducted: 42, remaining: 3958 },
  };

  it("requests a generation, polls every 5 seconds until completion and saves the PDF", async () => {
    const { t, result } = await production([{ status: "pending" }, { status: "pending" }, completed]);
    expect(result.slides).toEqual({ generationId: "gen1", gammaUrl: "https://gamma.app/docs/abc", creditsDeducted: 42 });
    expect(t.delays).toEqual([5000, 5000, 5000]);
    const post = t.calls.find((c) => c.init?.method === "POST" && c.url.includes("gamma"))!;
    expect((post.init!.headers as Record<string, string>)["X-API-KEY"]).toBe("gamma");
    expect(JSON.parse(post.init!.body as string).textMode).toBe("generate");
    expect([...t.drive.find([...DAY_PATH, "slides.pdf"])!.content]).toEqual([37, 80, 68, 70]);
    expect(JSON.parse(t.drive.find([...DAY_PATH, "slides.json"])!.content.toString())).toEqual(result.slides);
    expect(t.logs).toContain("slides: generated, credits deducted: 42");
  });

  it("allows credits to be missing", async () => {
    const { result } = await production([{ ...completed, credits: undefined }]);
    expect(result.slides!.creditsDeducted).toBeNull();
  });

  it.each([
    [[{ status: "failed", error: { message: "Out of credits", statusCode: 402 } }], {}, "Gamma generation gen1 failed: 402 Out of credits"],
    [[completed], { post: new Response("insufficient credits", { status: 402 }) }, "Gamma generation request failed: HTTP 402 insufficient credits"],
    [[completed], { post: Response.json({}) }, "Gamma generation request returned no generationId"],
    [[{ status: "weird" }], {}, "Gamma generation gen1 returned unknown status: weird"],
    [[{ ...completed, exportUrl: undefined }], {}, "Gamma generation gen1 has no exportUrl"],
    [[{ ...completed, gammaUrl: undefined }], {}, "Gamma generation gen1 has no gammaUrl"],
    [[completed], { download: new Response("gone", { status: 403 }) }, "Gamma PDF download failed: HTTP 403"],
    [[completed], { download: new Response(new Uint8Array()) }, "Gamma PDF download returned an empty file"],
  ])("falls back to a text digest when Gamma fails (%#)", async (statuses, options, message) => {
    const { t, result } = await production(statuses, options as { post?: Response; download?: Response });
    expect(result.slidesError).toBe(message);
    expect(result.slides).toBeNull();
    expect(t.drive.find([...DAY_PATH, "slides.pdf"])).toBeUndefined();
    expect(t.discordPosts().join("\n")).toContain(`⚠️ スライドを生成できなかったため、テキスト版を送ります: ${message}`);
  });

  it("retries the generation request 4 times in total", async () => {
    const { t } = await production([completed], { post: new Response("error", { status: 500 }) });
    expect(t.calls.filter((c) => c.init?.method === "POST" && c.url.includes("gamma"))).toHaveLength(4);
  });

  it("gives up after polling for 15 minutes", async () => {
    const { t, result } = await production([{ status: "pending" }]);
    expect(result.slidesError).toBe("Gamma generation gen1 did not complete within 900 seconds");
    expect(t.delays.filter((d) => d === 5000)).toHaveLength(180);
  });

  it("retries a failing status request", async () => {
    const { result } = await production([completed], { status: new Response("error", { status: 502 }) });
    expect(result.slides!.gammaUrl).toBe("https://gamma.app/docs/abc");
  });

  it("treats a missing GAMMA_API_KEY as a Gamma failure without calling Gamma", async () => {
    const t = await setup();
    t.drive.put([...DAY_PATH, "selection.json"], JSON.stringify(selectionJson([{ id: "1", score: 90, selected: true }])));
    t.drive.put([...DAY_PATH, "digest.json"], JSON.stringify(digestJson()));
    const result = await t.run(["--no-dry-run", "--from=slides"], {}, { ...t.env, GAMMA_API_KEY: undefined });
    expect(result.slidesError).toBe("GAMMA_API_KEY is not set");
    expect(t.calls.some((c) => c.url.includes("gamma.app"))).toBe(false);
  });

  it("never persists, posts or logs the Gamma exportUrl", async () => {
    const { t } = await production([completed]);
    for (const entry of t.drive.entries) expect(entry.content.toString("latin1")).not.toContain("secret-token");
    for (const post of t.discordPosts()) expect(post).not.toContain("secret-token");
    for (const log of t.logs) expect(log).not.toContain("secret-token");
  });
});

describe("④ 配信", () => {
  const twoArticles = digestJson({
    totalCandidates: 312,
    articles: [
      { ...articleJson(2, "Web", 80.04), key_points: ["p2"] },
      { ...articleJson(1, "AI/LLM", 90.55), key_points: ["p1-1", "p1-2"], caveats: ["c1"] },
    ],
  });

  it("renders digest.md in rank order", async () => {
    const t = await setup();
    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]), "digest.json": twoArticles });
    await t.run(["--from=deliver"]);
    expect(await readFile(join(t.dayDir(TODAY), "digest.md"), "utf-8")).toBe(`# 今日の見出し

- 日付: ${TODAY}
- 選定: 312本の候補から2本
- Gamma: なし

## 1. 記事1

- 分野: AI/LLM
- スコア: 90.6
- 元記事: https://a.example/1

### 何が起きたか

what1

### なぜ重要か

why1

### 技術的なポイント

- p1-1
- p1-2

### 注意点・限界

- c1

## 2. 記事2

- 分野: Web
- スコア: 80
- 元記事: https://a.example/2

### 何が起きたか

what2

### なぜ重要か

why2

### 技術的なポイント

- p2
`);
  });

  it("lists failed sources and articles in digest.md and the Discord message", async () => {
    const t = await setup();
    await writeDay(t, {
      "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]),
      "digest.json": digestJson({
        failedSources: [{ source: "Qiita", message: "QIITA_TOKEN is not set" }],
        failedArticles: [{ url: "https://a.example/x", title: "記事X", message: "HTTP 500" }],
      }),
    });
    const { discordMessages } = await t.run(["--from=deliver"]);
    const markdown = await readFile(join(t.dayDir(TODAY), "digest.md"), "utf-8");
    expect(markdown).toContain("## 取得できなかった情報源\n\n- Qiita: QIITA_TOKEN is not set");
    expect(markdown).toContain("## 本文を取得できなかった記事\n\n- 記事X (https://a.example/x): HTTP 500");
    expect(discordMessages[0]).toContain("⚠️ 取得できなかった情報源:\n- Qiita: QIITA_TOKEN is not set");
    expect(discordMessages[0]).toContain("⚠️ 本文を取得できなかった記事:\n- 記事X <https://a.example/x>: HTTP 500");
  });

  it("writes the Discord preview to discord.txt in dry-run, including the text digest", async () => {
    const t = await setup();
    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]), "digest.json": twoArticles });
    await t.run(["--from=deliver"]);
    const preview = await readFile(join(t.dayDir(TODAY), "discord.txt"), "utf-8");
    expect(preview).toContain("📰 **2026-11-03 Tech Digest: 今日の見出し**\n\n1. [AI/LLM] 記事1\n2. [Web] 記事2");
    expect(preview).toContain("⚠️ スライドを生成できなかったため、テキスト版を送ります: dry-run のためスライドを生成していません");
    expect(preview).toContain("- 元記事: <https://a.example/1>");
    expect(preview).not.toContain("📄 PDF");
  });

  it("splits long content into messages of at most 2000 characters", async () => {
    const t = await setup();
    await writeDay(t, {
      "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]),
      "digest.json": digestJson({
        title: "x".repeat(4500),
        articles: Array.from({ length: 10 }, (_, i) => ({ ...articleJson(i + 1, "Web", 50), what: "あ".repeat(500), why_it_matters: "い".repeat(500) })),
      }),
    });
    const { discordMessages } = await t.run(["--from=deliver"]);
    expect(discordMessages.length).toBeGreaterThan(3);
    expect(discordMessages.every((m) => m.length <= 2000 && m.trim() !== "")).toBe(true);
    expect(discordMessages.join("\n")).toContain("あ".repeat(500));
  });

  it("saves every file to Drive, updates state.json and notifies Discord with the links", async () => {
    const t = await setup();
    const result = await t.run(["--no-dry-run"]);
    for (const name of ["selection.json", "digest.json", "digest.md", "slides.pdf", "slides.json"]) {
      expect(t.drive.find([...DAY_PATH, name]), name).toBeDefined();
    }
    expect(t.drive.find([...DAY_PATH, "digest.md"])!.content.toString()).toContain("- Gamma: https://gamma.app/docs/abc");
    expect(JSON.parse(t.drive.find(["TechDigest", "state.json"])!.content.toString())).toEqual(result.state);
    const posts = t.discordPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`📄 PDF: https://drive.example/${t.drive.find([...DAY_PATH, "slides.pdf"])!.id}`);
    expect(posts[0]).toContain("🎞️ Gamma: https://gamma.app/docs/abc");
    expect(posts[0]).toContain(`📝 digest.md: https://drive.example/${t.drive.find([...DAY_PATH, "digest.md"])!.id}`);
    expect(posts[0]).not.toContain("テキスト版");
    const post = t.calls.find((c) => c.url === WEBHOOK)!;
    expect(JSON.parse(post.init!.body as string).allowed_mentions).toEqual({ parse: [] });
  });

  it("overwrites existing Drive files and reuses folders on rerun", async () => {
    const t = await setup();
    await t.run(["--no-dry-run"]);
    const count = t.drive.entries.length;
    await t.run(["--no-dry-run"], { now: new Date(NOW.getTime() + 60_000) });
    expect(t.drive.entries).toHaveLength(count);
    expect(t.drive.entries.filter((e) => e.name === "TechDigest")).toHaveLength(1);
  });

  it("saves digest.md and sends a text digest when Gamma fails", async () => {
    const t = await setup({ gamma: "fail" });
    const result = await t.run(["--no-dry-run"]);
    expect(t.drive.find([...DAY_PATH, "digest.md"])!.content.toString()).toContain("- Gamma: なし");
    expect(t.drive.find([...DAY_PATH, "slides.pdf"])).toBeUndefined();
    expect(result.slidesError).toBe("Gamma generation request failed: HTTP 402 no credits");
    const posts = t.discordPosts().join("\n");
    expect(posts).toContain("### なぜ重要か");
    expect(JSON.parse(t.drive.find(["TechDigest", "state.json"])!.content.toString()).published).toHaveLength(2);
  });

  it("retries a failed Discord post and reports the failure", async () => {
    const t = await setup({ feed: (url) => (url === WEBHOOK ? new Response("rate limited", { status: 429 }) : undefined) });
    await expect(t.run(["--no-dry-run"])).rejects.toThrow("Discord webhook failed: HTTP 429");
    expect(t.calls.filter((c) => c.url === WEBHOOK)).toHaveLength(8);
    expect(t.logs.some((l) => l.startsWith("failed to notify the error to Discord"))).toBe(true);
    expect(t.drive.find(["TechDigest", "state.json"])).toBeDefined();
  });

  it("retries Drive calls and notifies Discord when Drive keeps failing", async () => {
    const t = await setup();
    t.drive.failures.create = 2;
    await t.run(["--no-dry-run"]);
    expect(t.delays.slice(0, 2)).toEqual([2000, 4000]);

    const broken = await setup();
    broken.drive.failures.list = 100;
    await expect(broken.run(["--no-dry-run"])).rejects.toThrow("fake drive list failure");
    expect(broken.discordPosts()[0]).toBe(`⚠️ ${TODAY} の Tech Digest の生成に失敗しました(工程: 保存先の準備)\nfake drive list failure`);
  });

  it("does not treat a folder with the same name as a file", async () => {
    const t = await setup();
    t.drive.put([...DAY_PATH, "digest.md", "placeholder"], "x");
    await t.run(["--no-dry-run"]);
    expect(t.drive.entries.filter((e) => e.name === "digest.md")).toHaveLength(2);
  });
});

describe("state.json と再実行", () => {
  it("records the run and published URLs", async () => {
    const t = await setup();
    await t.run();
    expect(await readJson(join(t.outDir, "state.json"))).toEqual({
      runs: [{ date: TODAY, since: SINCE_DEFAULT, until: NOW.toISOString() }],
      published: [
        { url: "https://a.example/llm", date: TODAY },
        { url: "https://a.example/web", date: TODAY },
      ],
    });
  });

  it("collects since the latest previous run, even after skipped days", async () => {
    const t = await setup();
    await writeFile(
      join(t.outDir, "state.json"),
      JSON.stringify({
        runs: [
          { date: "2026-10-20", since: "2026-10-18T22:00:00.000Z", until: "2026-10-19T22:00:00.000Z" },
          { date: "2026-10-25", since: "2026-10-19T22:00:00.000Z", until: "2026-10-24T22:05:00.000Z" },
        ],
        published: [],
      }),
    );
    const { selection, state } = await t.run();
    expect(selection.since).toBe("2026-10-24T22:05:00.000Z");
    expect(state.runs.map((r) => r.date)).toEqual(["2026-10-20", "2026-10-25", TODAY]);
  });

  it("reuses the same window and does not duplicate published URLs on a same-day rerun", async () => {
    const t = await setup();
    const first = await t.run();
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const second = await t.run([], { now: later });
    expect(second.selection.since).toBe(first.selection.since);
    expect(second.selection.until).toBe(later.toISOString());
    expect(second.digest.articles.map((a) => a.url)).toEqual(first.digest.articles.map((a) => a.url));
    expect(second.state.published).toHaveLength(2);
    expect(second.state.runs).toHaveLength(1);
  });

  it("drops runs and published URLs older than 30 days", async () => {
    const t = await setup();
    await writeFile(
      join(t.outDir, "state.json"),
      JSON.stringify({
        runs: [
          { date: "2026-10-03", since: "2026-10-01T22:00:00.000Z", until: "2026-10-02T22:00:00.000Z" },
          { date: "2026-10-04", since: "2026-10-02T22:00:00.000Z", until: "2026-10-03T22:00:00.000Z" },
        ],
        published: [
          { url: "https://x.example/old", date: "2026-10-03" },
          { url: "https://x.example/kept", date: "2026-10-04" },
        ],
      }),
    );
    const { state } = await t.run();
    expect(state.runs.map((r) => r.date)).toEqual(["2026-10-04", TODAY]);
    expect(state.published.map((p) => p.url)).toEqual(["https://x.example/kept", "https://a.example/llm", "https://a.example/web"]);
  });

  it("reads state.json from Drive unless dry-run", async () => {
    const t = await setup();
    t.drive.put(
      ["TechDigest", "state.json"],
      JSON.stringify({
        runs: [{ date: "2026-11-02", since: "2026-11-01T22:00:00.000Z", until: "2026-11-01T22:30:00.000Z" }],
        published: [{ url: "https://a.example/llm", date: "2026-11-02" }],
      }),
    );
    const { selection, digest } = await t.run(["--no-dry-run"]);
    expect(selection.since).toBe("2026-11-01T22:30:00.000Z");
    expect(digest.articles.map((a) => a.url)).toEqual(["https://a.example/web"]);
  });

  it("rejects a broken state.json instead of overwriting it", async () => {
    const t = await setup();
    await writeFile(join(t.outDir, "state.json"), "{broken");
    await expect(t.run()).rejects.toThrow();
    expect(await readFile(join(t.outDir, "state.json"), "utf-8")).toBe("{broken");
  });

  it("does not update the state when a step fails, and notifies Discord unless dry-run", async () => {
    const t = await setup({
      claude: () => {
        throw new Error("Claude is down");
      },
    });
    await expect(t.run()).rejects.toThrow("Claude is down");
    await expect(readFile(join(t.outDir, "state.json"))).rejects.toThrow();
    expect(t.discordPosts()).toEqual([]);

    await expect(t.run(["--no-dry-run"])).rejects.toThrow("Claude is down");
    expect(t.discordPosts()).toEqual([`⚠️ ${TODAY} の Tech Digest の生成に失敗しました(工程: 収集・選定)\nClaude is down`]);
    expect(t.drive.find(["TechDigest", "state.json"])).toBeUndefined();
    expect(t.drive.find([...DAY_PATH, "selection.json"])).toBeUndefined();
  });

  it("keeps selection.json on Drive when summarization fails so that it can be resumed", async () => {
    const t = await setup({ feed: (url) => (url.startsWith("https://r.jina.ai/") ? new Response("error", { status: 500 }) : undefined) });
    await expect(t.run(["--no-dry-run"])).rejects.toThrow("No article body could be fetched");
    expect(t.drive.find([...DAY_PATH, "selection.json"])).toBeDefined();
    expect(t.discordPosts()[0]).toContain("工程: 要約");
  });

  it("starts from summarize using the saved selection.json without judging again", async () => {
    const t = await setup();
    await t.run();
    const judged = t.claudeRequests.filter((r) => r.model === "r").length;
    const result = await t.run(["--from=summarize"]);
    expect(t.claudeRequests.filter((r) => r.model === "r")).toHaveLength(judged);
    expect(result.digest.articles).toHaveLength(2);
  });

  it("starts from slides using digest.json on Drive without calling Claude", async () => {
    const t = await setup();
    await t.run(["--no-dry-run"]);
    const before = t.claudeRequests.length;
    const result = await t.run(["--no-dry-run", "--from=slides"]);
    expect(t.claudeRequests).toHaveLength(before);
    expect(result.slides?.gammaUrl).toBe("https://gamma.app/docs/abc");
  });

  it("starts from deliver using slides on Drive without calling Gamma", async () => {
    const t = await setup();
    await t.run(["--no-dry-run"]);
    const gammaCalls = t.calls.filter((c) => c.url.includes("gamma.app")).length;
    const result = await t.run(["--no-dry-run", "--from=deliver"]);
    expect(t.calls.filter((c) => c.url.includes("gamma.app"))).toHaveLength(gammaCalls);
    expect(result.slidesError).toBeNull();
    expect(t.discordPosts().at(-1)).toContain("📄 PDF:");
    expect(t.drive.entries.filter((e) => e.name === "slides.pdf")).toHaveLength(1);
  });

  it("falls back to a text digest when starting from deliver without slides on Drive", async () => {
    const t = await setup({ gamma: "fail" });
    await t.run(["--no-dry-run"]);
    const result = await t.run(["--no-dry-run", "--from=deliver"]);
    expect(result.slidesError).toBe(`slides.pdf / slides.json for ${TODAY} were not found`);
  });

  it("throws when the intermediate file for the start step is missing or for another date", async () => {
    const t = await setup();
    await expect(t.run(["--from=summarize"])).rejects.toThrow(`selection.json for ${TODAY} was not found`);
    await expect(t.run(["--from=slides"])).rejects.toThrow(`selection.json for ${TODAY} was not found`);

    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]) });
    await expect(t.run(["--from=slides"])).rejects.toThrow(`digest.json for ${TODAY} was not found`);

    await writeDay(t, { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }]) }, "2026-11-01");
    await expect(t.run(["--from=summarize", "--date=2026-11-01"])).rejects.toThrow(
      `selection.json is for ${TODAY}, not 2026-11-01`,
    );
    await writeDay(
      t,
      { "selection.json": selectionJson([{ id: "1", score: 90, selected: true }], "2026-11-01"), "digest.json": digestJson() },
      "2026-11-01",
    );
    await expect(t.run(["--from=slides", "--date=2026-11-01"])).rejects.toThrow(`digest.json is for ${TODAY}, not 2026-11-01`);
  });

  it("rejects intermediate files that do not match the schema", async () => {
    const t = await setup();
    const selection = selectionJson([{ id: "1", score: 90, selected: true }]);
    await writeDay(t, { "selection.json": { ...selection, totalCandidates: 99 } });
    await expect(t.run(["--from=summarize"])).rejects.toThrow("totalCandidates must equal the number of candidates");
    await writeDay(t, { "selection.json": { ...selection, selected: [{ ...selection.selected[0], rank: 2 }] } });
    await expect(t.run(["--from=summarize"])).rejects.toThrow("selected ranks must be consecutive");
    await writeDay(t, { "selection.json": selection, "digest.json": digestJson({ articles: [articleJson(1, "Web", 1), articleJson(1, "Web", 2)] }) });
    await expect(t.run(["--from=slides"])).rejects.toThrow("article ranks must be unique");
  });
});
