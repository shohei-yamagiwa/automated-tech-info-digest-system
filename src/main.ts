import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as cheerio from "cheerio";
import { google, type drive_v3 } from "googleapis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import Parser from "rss-parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Deps = {
  now?: Date;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  anthropic?: Anthropic;
  drive?: drive_v3.Drive;
  rootDir?: string;
  outDir?: string;
  log?: (message: string) => void;
};

const STEPS = ["select", "summarize", "slides", "deliver"] as const;
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const ROOT_FOLDER = "TechDigest";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const USER_AGENT = "automated-tech-info-digest-system (personal use)";
const HATENA_CRAWL_DELAY_MS = 5000;
const QIITA_PER_PAGE = 100;
const QIITA_MAX_PAGE = 100;
const JUDGE_SUMMARY_MAX_LENGTH = 500;
const GAMMA_API_BASE = "https://public-api.gamma.app/v1.0";
const GAMMA_POLL_INTERVAL_MS = 5000;
const GAMMA_MAX_POLLS = 180;
const GAMMA_INPUT_TEXT_MAX_LENGTH = 400_000;
const DISCORD_MAX_LENGTH = 2000;
const DRY_RUN_SLIDES_MESSAGE = "dry-run のためスライドを生成していません";

const JUDGE_SYSTEM_PROMPT = `あなたは技術記事の選定アシスタントです。
与えられた各記事について、タイトルと概要だけを根拠に、次の3つを判定してください。

- relevance: 下記の関心領域にどれだけ合致するか(0〜100の整数)
- domain: 最も近い関心領域の名前(下記の名前のいずれか)
- topic: 話題のまとまりを表す短いラベル。同じ出来事・同じ製品・同じ話題を扱う記事には、必ず完全に同じラベルを付けること。

すべての記事について、index を付けて1件ずつ判定を返してください。

# 関心領域
`;

const DIGEST_TITLE_PROMPT = `あなたは技術ダイジェストの編集者です。
その日に取り上げる記事の一覧(タイトルと概要)が与えられます。
一覧全体を表す、日本語の見出しを1つだけ作ってください。一覧にない事実は書かないでください。`;

const GAMMA_ADDITIONAL_INSTRUCTIONS = `- 原稿にない事実や数値を付け加えないでください。
- 各記事の元記事リンクを必ず残してください。
- 表現方法(図解・表・レイアウトなど)は自由に選んでかまいません。
- 表紙には、今日のタイトル、注目3本、分野ごとの内訳、日付と選定の規模を載せてください。
- 記事は原稿の順番(分野ごと、同じ分野の中ではスコアの高い順)のまま並べてください。`;

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: Deps = {},
) {
  let dryRun = true;
  let dateArg: string | undefined;
  let from: (typeof STEPS)[number] = "select";
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-dry-run") {
      dryRun = false;
    } else if (arg.startsWith("--date=")) {
      dateArg = arg.slice("--date=".length) || undefined;
    } else if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (!(STEPS as readonly string[]).includes(value)) {
        throw new Error(`--from must be one of ${STEPS.join(", ")}: ${value}`);
      }
      from = value as (typeof STEPS)[number];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const now = deps.now ?? new Date();
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((message: string) => console.log(message));
  const rootDir = deps.rootDir ?? process.cwd();
  const outDir = deps.outDir ?? "out";
  const webhookUrl = env["DISCORD_WEBHOOK_URL"] ?? "";
  const todayJst = new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
  const date = dateArg ?? todayJst;
  let currentStep = "開始前の検証";

  try {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    ) {
      throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
    }
    if (date > todayJst) throw new Error(`Date must not be in the future: ${date} > ${todayJst}`);
    if (!dryRun && webhookUrl === "") throw new Error("DISCORD_WEBHOOK_URL is required unless dry-run");

    let drive: drive_v3.Drive | null = null;
    if (!dryRun) {
      if (deps.drive) {
        drive = deps.drive;
      } else {
        const clientId = env["GOOGLE_CLIENT_ID"];
        const clientSecret = env["GOOGLE_CLIENT_SECRET"];
        const refreshToken = env["GOOGLE_REFRESH_TOKEN"];
        if (!clientId || !clientSecret || !refreshToken) {
          throw new Error(
            "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required unless dry-run",
          );
        }
        const auth = new google.auth.OAuth2(clientId, clientSecret);
        auth.setCredentials({ refresh_token: refreshToken });
        drive = google.drive({ version: "v3", auth });
      }
    }
    const anthropic = deps.anthropic ?? new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"], maxRetries: 0 });
    const fromIndex = STEPS.indexOf(from);

    currentStep = "設定の読み込み";
    const interestsFileSchema = z.strictObject({
      interests: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            description: z.string().min(1),
            weight: z.number().positive(),
          }),
        )
        .min(1)
        .refine((items) => new Set(items.map((i) => i.name)).size === items.length, {
          message: "interest names must be unique",
        }),
    });
    const sourcesFileSchema = z.strictObject({
      sources: z
        .array(
          z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("rss"), name: z.string().min(1), url: z.url() }),
            z.strictObject({ type: z.literal("hackernews"), minPoints: z.int().nonnegative().default(100) }),
            z.strictObject({ type: z.literal("github-trending") }),
            z.strictObject({ type: z.literal("hatena-hotentry") }),
            z.strictObject({
              type: z.literal("zenn"),
              topics: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
            }),
            z.strictObject({ type: z.literal("qiita"), minStocks: z.int().nonnegative().default(0) }),
          ]),
        )
        .min(1),
    });
    const settingsFileSchema = z.strictObject({
      selection: z.strictObject({ count: z.int().min(1), maxPerDomain: z.int().min(1) }),
      scoring: z.strictObject({ popularityStrength: z.number().nonnegative() }),
      models: z.strictObject({ relevance: z.string().min(1), summarize: z.string().min(1) }),
      slides: z.strictObject({
        numCards: z.int().min(1),
        themeId: z.string().min(1).optional(),
        folderId: z.string().min(1).optional(),
      }),
    });
    const popularitySchema = z.strictObject({ source: z.string().min(1), name: z.string().min(1), value: z.number() });
    const failedSourceSchema = z.strictObject({ source: z.string().min(1), message: z.string() });
    const selectionSchema = z
      .strictObject({
        date: z.iso.date(),
        since: z.iso.datetime(),
        until: z.iso.datetime(),
        totalCandidates: z.int().nonnegative(),
        selected: z.array(
          z.strictObject({
            rank: z.int().min(1),
            url: z.url(),
            title: z.string().min(1),
            score: z.number(),
            domain: z.string().min(1),
            topic: z.string().min(1),
            popularity: z.array(popularitySchema),
          }),
        ),
        candidates: z.array(
          z.strictObject({
            url: z.url(),
            title: z.string().min(1),
            relevance: z.number().min(0).max(100),
            domain: z.string().min(1),
            topic: z.string().min(1),
            popularity: z.array(popularitySchema),
            score: z.number(),
            selected: z.boolean(),
            reason: z.string().min(1),
          }),
        ),
        failedSources: z.array(failedSourceSchema),
      })
      .refine((s) => s.selected.every((article, i) => article.rank === i + 1), {
        message: "selected ranks must be consecutive starting from 1",
      })
      .refine((s) => s.totalCandidates === s.candidates.length, {
        message: "totalCandidates must equal the number of candidates",
      })
      .refine((s) => s.candidates.filter((c) => c.selected).length === s.selected.length, {
        message: "the number of selected candidates must equal the number of selected articles",
      });
    const articleSummarySchema = z.strictObject({
      title: z.string().min(1),
      what: z.string().min(1),
      why_it_matters: z.string().min(1),
      key_points: z.array(z.string().min(1)).min(1),
      caveats: z.array(z.string().min(1)),
    });
    const digestSchema = z
      .strictObject({
        date: z.iso.date(),
        title: z.string().min(1),
        totalCandidates: z.int().nonnegative(),
        articles: z
          .array(
            articleSummarySchema.extend({
              rank: z.int().min(1),
              score: z.number(),
              domain: z.string().min(1),
              url: z.url(),
            }),
          )
          .min(1),
        failedSources: z.array(failedSourceSchema),
        failedArticles: z.array(z.strictObject({ url: z.url(), title: z.string(), message: z.string() })),
      })
      .refine((d) => new Set(d.articles.map((a) => a.rank)).size === d.articles.length, {
        message: "article ranks must be unique",
      });
    const slidesMetaSchema = z.strictObject({
      generationId: z.string().min(1),
      gammaUrl: z.url(),
      creditsDeducted: z.number().nullable(),
    });
    const stateSchema = z.strictObject({
      runs: z.array(z.strictObject({ date: z.iso.date(), since: z.iso.datetime(), until: z.iso.datetime() })),
      published: z.array(z.strictObject({ url: z.url(), date: z.iso.date() })),
    });

    const { interests } = interestsFileSchema.parse(
      parseYaml(await readFile(join(rootDir, "config/interests.yaml"), "utf-8")),
    );
    const { sources } = sourcesFileSchema.parse(
      parseYaml(await readFile(join(rootDir, "config/sources.yaml"), "utf-8")),
    );
    const settings = settingsFileSchema.parse(
      parseYaml(await readFile(join(rootDir, "config/settings.yaml"), "utf-8")),
    );
    const summarizePrompt = await readFile(join(rootDir, "prompts/summarize.md"), "utf-8");
    if (summarizePrompt.trim() === "") throw new Error("prompts/summarize.md is empty");

    const [year, month, day] = date.split("-") as [string, string, string];
    const localDayDir = join(outDir, year, month, day);
    await mkdir(localDayDir, { recursive: true });

    currentStep = "保存先の準備";
    let rootFolderId = "";
    let dayFolderId = "";
    if (drive !== null) {
      let parentId = "root";
      for (const [index, folderName] of [ROOT_FOLDER, year, month, day].entries()) {
        const parent = parentId;
        let folderId: string | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            const found = await drive.files.list({
              q: `name = '${folderName.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' and mimeType = '${FOLDER_MIME_TYPE}' and '${parent}' in parents and trashed = false`,
              fields: "files(id)",
              spaces: "drive",
            });
            folderId = found.data.files?.[0]?.id ?? undefined;
            break;
          } catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length) throw error;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }
        if (!folderId) {
          for (let attempt = 0; ; attempt++) {
            try {
              const created = await drive.files.create({
                requestBody: { name: folderName, mimeType: FOLDER_MIME_TYPE, parents: [parent] },
                fields: "id",
              });
              if (!created.data.id) throw new Error(`Failed to create Drive folder: ${folderName}`);
              folderId = created.data.id;
              break;
            } catch (error) {
              if (attempt >= RETRY_DELAYS_MS.length) throw error;
              await sleep(RETRY_DELAYS_MS[attempt]!);
            }
          }
        }
        if (index === 0) rootFolderId = folderId;
        parentId = folderId;
      }
      dayFolderId = parentId;
    }

    currentStep = "保存済みファイルの読み込み";
    const toLoad: { name: string; folder: "root" | "day" }[] = [{ name: "state.json", folder: "root" }];
    if (fromIndex > STEPS.indexOf("select")) toLoad.push({ name: "selection.json", folder: "day" });
    if (fromIndex > STEPS.indexOf("summarize")) toLoad.push({ name: "digest.json", folder: "day" });
    if (fromIndex > STEPS.indexOf("slides")) {
      toLoad.push({ name: "slides.json", folder: "day" }, { name: "slides.pdf", folder: "day" });
    }
    const loaded = new Map<string, Buffer | null>();
    for (const item of toLoad) {
      if (drive === null) {
        try {
          loaded.set(item.name, await readFile(join(item.folder === "root" ? outDir : localDayDir, item.name)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          loaded.set(item.name, null);
        }
        continue;
      }
      const folderId = item.folder === "root" ? rootFolderId : dayFolderId;
      let fileId: string | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          const found = await drive.files.list({
            q: `name = '${item.name}' and '${folderId}' in parents and mimeType != '${FOLDER_MIME_TYPE}' and trashed = false`,
            fields: "files(id)",
            spaces: "drive",
          });
          fileId = found.data.files?.[0]?.id ?? undefined;
          break;
        } catch (error) {
          if (attempt >= RETRY_DELAYS_MS.length) throw error;
          await sleep(RETRY_DELAYS_MS[attempt]!);
        }
      }
      if (!fileId) {
        loaded.set(item.name, null);
        continue;
      }
      const id = fileId;
      for (let attempt = 0; ; attempt++) {
        try {
          const downloaded = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "arraybuffer" });
          loaded.set(item.name, Buffer.from(downloaded.data as unknown as ArrayBuffer));
          break;
        } catch (error) {
          if (attempt >= RETRY_DELAYS_MS.length) throw error;
          await sleep(RETRY_DELAYS_MS[attempt]!);
        }
      }
    }

    const stateRaw = loaded.get("state.json") ?? null;
    const state: z.infer<typeof stateSchema> =
      stateRaw === null ? { runs: [], published: [] } : stateSchema.parse(JSON.parse(stateRaw.toString("utf-8")));

    let selection: z.infer<typeof selectionSchema> | null = null;
    if (fromIndex > STEPS.indexOf("select")) {
      const raw = loaded.get("selection.json") ?? null;
      if (raw === null) throw new Error(`selection.json for ${date} was not found`);
      selection = selectionSchema.parse(JSON.parse(raw.toString("utf-8")));
      if (selection.date !== date) throw new Error(`selection.json is for ${selection.date}, not ${date}`);
    }
    let digest: z.infer<typeof digestSchema> | null = null;
    if (fromIndex > STEPS.indexOf("summarize")) {
      const raw = loaded.get("digest.json") ?? null;
      if (raw === null) throw new Error(`digest.json for ${date} was not found`);
      digest = digestSchema.parse(JSON.parse(raw.toString("utf-8")));
      if (digest.date !== date) throw new Error(`digest.json is for ${digest.date}, not ${date}`);
    }
    let slides: z.infer<typeof slidesMetaSchema> | null = null;
    let pdf: Uint8Array | null = null;
    let slidesError: string | null = null;
    if (fromIndex > STEPS.indexOf("slides")) {
      const rawMeta = loaded.get("slides.json") ?? null;
      const rawPdf = loaded.get("slides.pdf") ?? null;
      if (rawMeta !== null && rawPdf !== null) {
        slides = slidesMetaSchema.parse(JSON.parse(rawMeta.toString("utf-8")));
        pdf = rawPdf;
      } else {
        slidesError = dryRun ? DRY_RUN_SLIDES_MESSAGE : `slides.pdf / slides.json for ${date} were not found`;
      }
    }

    let newState: z.infer<typeof stateSchema> | null = null;
    let discordMessages: string[] = [];

    for (const step of STEPS.slice(fromIndex)) {
      const filesToSave: { name: string; mimeType: string; content: string | Uint8Array; folder: "root" | "day" }[] = [];

      if (step === "select") {
        currentStep = "収集・選定";
        const sameDayRun = state.runs.find((r) => r.date === date);
        const previousUntil = state.runs
          .filter((r) => r.date < date)
          .map((r) => new Date(r.until))
          .sort((a, b) => b.getTime() - a.getTime())[0];
        const until = now;
        const since = sameDayRun ? new Date(sameDayRun.since) : (previousUntil ?? new Date(until.getTime() - DAY_MS));

        const targets: {
          label: string;
          kind: "feed" | "hatena" | "hackernews" | "github-trending" | "qiita";
          url: string;
          headers: Record<string, string>;
          minDelayMs: number;
          page: number;
        }[] = [];
        const failedSources: { source: string; message: string }[] = [];
        const attemptedLabels = new Set<string>();
        const sinceDateJst = new Date(since.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
        for (const source of sources) {
          if (source.type === "rss") {
            targets.push({ label: source.name, kind: "feed", url: source.url, headers: {}, minDelayMs: 0, page: 1 });
          } else if (source.type === "hatena-hotentry") {
            targets.push({
              label: "はてなブックマーク",
              kind: "hatena",
              url: "https://b.hatena.ne.jp/hotentry/it.rss",
              headers: {},
              minDelayMs: HATENA_CRAWL_DELAY_MS,
              page: 1,
            });
          } else if (source.type === "zenn") {
            targets.push({ label: "Zenn", kind: "feed", url: "https://zenn.dev/feed", headers: {}, minDelayMs: 0, page: 1 });
            for (const topic of source.topics) {
              targets.push({
                label: `Zenn (${topic})`,
                kind: "feed",
                url: `https://zenn.dev/topics/${topic}/feed`,
                headers: {},
                minDelayMs: 0,
                page: 1,
              });
            }
          } else if (source.type === "hackernews") {
            const url = new URL("https://hn.algolia.com/api/v1/search_by_date");
            url.searchParams.set("tags", "story");
            url.searchParams.set(
              "numericFilters",
              `created_at_i>${Math.floor(since.getTime() / 1000)},points>${source.minPoints}`,
            );
            url.searchParams.set("hitsPerPage", "1000");
            targets.push({ label: "Hacker News", kind: "hackernews", url: url.toString(), headers: {}, minDelayMs: 0, page: 1 });
          } else if (source.type === "github-trending") {
            targets.push({
              label: "GitHub Trending",
              kind: "github-trending",
              url: "https://github.com/trending?since=daily",
              headers: {},
              minDelayMs: 0,
              page: 1,
            });
          } else if (source.type === "qiita") {
            const token = env["QIITA_TOKEN"];
            if (!token) {
              attemptedLabels.add("Qiita");
              failedSources.push({ source: "Qiita", message: "QIITA_TOKEN is not set" });
              continue;
            }
            const url = new URL("https://qiita.com/api/v2/items");
            url.searchParams.set("page", "1");
            url.searchParams.set("per_page", String(QIITA_PER_PAGE));
            url.searchParams.set(
              "query",
              source.minStocks > 0
                ? `created:>=${sinceDateJst} stocks:>${source.minStocks - 1}`
                : `created:>=${sinceDateJst}`,
            );
            targets.push({
              label: "Qiita",
              kind: "qiita",
              url: url.toString(),
              headers: { Authorization: `Bearer ${token}` },
              minDelayMs: 0,
              page: 1,
            });
          }
        }

        const feedParser = new Parser<unknown, { "hatena:bookmarkcount"?: string; "dc:date"?: string }>({
          customFields: { item: ["hatena:bookmarkcount", "dc:date"] },
        });
        const collected: {
          url: string;
          title: string;
          summary: string;
          popularity: { source: string; name: string; value: number }[];
        }[] = [];
        for (let t = 0; t < targets.length; t++) {
          const target = targets[t]!;
          attemptedLabels.add(target.label);
          try {
            let text!: string;
            for (let attempt = 0; ; attempt++) {
              try {
                const response = await fetchFn(target.url, {
                  headers: { "User-Agent": USER_AGENT, ...target.headers },
                });
                if (!response.ok) throw new Error(`GET ${target.url} failed: HTTP ${response.status}`);
                text = await response.text();
                break;
              } catch (error) {
                if (attempt >= RETRY_DELAYS_MS.length) throw error;
                await sleep(Math.max(RETRY_DELAYS_MS[attempt]!, target.minDelayMs));
              }
            }

            if (target.kind === "feed" || target.kind === "hatena") {
              const feed = await feedParser.parseString(text);
              for (const item of feed.items) {
                if (!item.link || !item.title) continue;
                const published = item.isoDate ?? item["dc:date"];
                if (published !== undefined) {
                  const publishedAt = new Date(published);
                  if (!Number.isNaN(publishedAt.getTime()) && publishedAt < since) continue;
                }
                const popularity: { source: string; name: string; value: number }[] = [];
                if (target.kind === "hatena") {
                  const bookmarks = Number(item["hatena:bookmarkcount"]);
                  if (Number.isFinite(bookmarks)) popularity.push({ source: "hatena", name: "bookmarks", value: bookmarks });
                }
                collected.push({
                  url: item.link,
                  title: item.title.trim(),
                  summary: (item.contentSnippet ?? item.summary ?? "").trim(),
                  popularity,
                });
              }
            } else if (target.kind === "hackernews") {
              const body = JSON.parse(text) as {
                hits?: { title?: string; url?: string | null; points?: number; num_comments?: number }[];
              };
              if (!Array.isArray(body.hits)) throw new Error("Hacker News: unexpected response shape");
              for (const hit of body.hits) {
                if (!hit.url || !hit.title) continue;
                collected.push({
                  url: hit.url,
                  title: hit.title.trim(),
                  summary: "",
                  popularity: [
                    { source: "hackernews", name: "points", value: hit.points ?? 0 },
                    { source: "hackernews", name: "comments", value: hit.num_comments ?? 0 },
                  ],
                });
              }
            } else if (target.kind === "github-trending") {
              const $ = cheerio.load(text);
              let found = 0;
              $("article.Box-row").each((_, element) => {
                const article = $(element);
                const path = article.find("h2 a").attr("href")?.trim().replace(/^\//, "");
                if (!path || !/^[^/\s]+\/[^/\s]+$/.test(path)) return;
                const starsToday = /([\d,]+)\s+stars?\s+today/.exec(article.text())?.[1];
                found++;
                collected.push({
                  url: `https://github.com/${path}`,
                  title: path,
                  summary: article.find("p").first().text().trim(),
                  popularity:
                    starsToday === undefined
                      ? []
                      : [{ source: "github-trending", name: "stars-today", value: Number(starsToday.replaceAll(",", "")) }],
                });
              });
              if (found === 0) throw new Error("GitHub Trending: no repositories found in the page");
            } else {
              const items = JSON.parse(text) as {
                title: string;
                url: string;
                body?: string;
                created_at: string;
                likes_count: number;
                stocks_count: number;
              }[];
              if (!Array.isArray(items)) throw new Error("Qiita: unexpected response shape");
              for (const item of items) {
                if (new Date(item.created_at) < since) continue;
                collected.push({
                  url: item.url,
                  title: item.title.trim(),
                  summary: (item.body ?? "").trim(),
                  popularity: [
                    { source: "qiita", name: "likes", value: item.likes_count },
                    { source: "qiita", name: "stocks", value: item.stocks_count },
                  ],
                });
              }
              if (items.length === QIITA_PER_PAGE && target.page < QIITA_MAX_PAGE) {
                const nextUrl = new URL(target.url);
                nextUrl.searchParams.set("page", String(target.page + 1));
                targets.splice(t + 1, 0, { ...target, url: nextUrl.toString(), page: target.page + 1 });
              }
            }
          } catch (error) {
            failedSources.push({
              source: target.label,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (attemptedLabels.size > 0 && failedSources.length === attemptedLabels.size) {
          throw new Error(`All sources failed: ${failedSources.map((f) => `${f.source} (${f.message})`).join("; ")}`);
        }

        const excludedKeys = new Set<string>();
        const mergedByKey = new Map<string, (typeof collected)[number]>();
        const urlsToNormalize = [
          ...state.published
            .filter((p) => p.date !== date && Date.parse(date) - Date.parse(p.date) <= RETENTION_DAYS * DAY_MS)
            .map((p) => ({ url: p.url, item: null })),
          ...collected.map((item) => ({ url: item.url, item })),
        ];
        for (const { url: rawUrl, item } of urlsToNormalize) {
          let url: URL;
          try {
            url = new URL(rawUrl);
          } catch {
            continue;
          }
          if (url.protocol !== "http:" && url.protocol !== "https:") continue;
          url.protocol = "https:";
          url.hostname = url.hostname.replace(/^www\./, "");
          url.hash = "";
          for (const key of [...url.searchParams.keys()]) {
            if (/^(utm_.*|fbclid|gclid|ref|ref_src)$/.test(key)) url.searchParams.delete(key);
          }
          url.searchParams.sort();
          const key = `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;

          if (item === null) {
            excludedKeys.add(key);
            continue;
          }
          if (item.title === "" || excludedKeys.has(key)) continue;
          const existing = mergedByKey.get(key);
          if (!existing) {
            mergedByKey.set(key, { ...item, popularity: [...item.popularity] });
            continue;
          }
          if (existing.summary === "" && item.summary !== "") existing.summary = item.summary;
          for (const signal of item.popularity) {
            const same = existing.popularity.find((p) => p.source === signal.source && p.name === signal.name);
            if (!same) existing.popularity.push(signal);
            else same.value = Math.max(same.value, signal.value);
          }
        }
        const candidates = [...mergedByKey.values()];
        if (candidates.length === 0) {
          throw new Error("No candidates left after collecting, merging and excluding published articles");
        }

        const domainNames = interests.map((i) => i.name) as [string, ...string[]];
        const judgeSchema = z.object({
          judgements: z.array(
            z.object({
              index: z.int().min(0).max(candidates.length - 1),
              relevance: z.number().min(0).max(100),
              domain: z.enum(domainNames),
              topic: z.string().min(1),
            }),
          ),
        });
        let judgementsByIndex!: Map<number, z.infer<typeof judgeSchema>["judgements"][number]>;
        for (let attempt = 0; ; attempt++) {
          try {
            const message = await anthropic.beta.messages
              .stream({
                model: settings.models.relevance,
                max_tokens: 128000,
                system: JUDGE_SYSTEM_PROMPT + interests.map((i) => `- ${i.name}: ${i.description}`).join("\n"),
                messages: [
                  {
                    role: "user",
                    content: candidates
                      .map((c, index) => {
                        const summary = c.summary.slice(0, JUDGE_SUMMARY_MAX_LENGTH);
                        return `[${index}] ${c.title}${summary ? `\n${summary}` : ""}`;
                      })
                      .join("\n\n"),
                  },
                ],
                thinking: { type: "adaptive" },
                output_config: { effort: "high", format: betaZodOutputFormat(judgeSchema) },
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default",
              })
              .finalMessage();
            if (message.stop_reason === "refusal") {
              throw new Error(`Claude refused the request: ${message.stop_details?.category ?? "unknown category"}`);
            }
            if (message.stop_reason === "max_tokens") throw new Error("Claude hit max_tokens");
            const { judgements } = judgeSchema.parse(message.parsed_output);
            const byIndex = new Map(judgements.map((j) => [j.index, j]));
            if (byIndex.size !== candidates.length || judgements.length !== candidates.length) {
              throw new Error(
                `Expected one judgement for each of ${candidates.length} candidates but got ${judgements.length} (${byIndex.size} unique)`,
              );
            }
            judgementsByIndex = byIndex;
            break;
          } catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length) throw error;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }

        const valuesBySignal = new Map<string, number[]>();
        for (const candidate of candidates) {
          for (const signal of candidate.popularity) {
            const key = `${signal.source}:${signal.name}`;
            valuesBySignal.set(key, [...(valuesBySignal.get(key) ?? []), signal.value]);
          }
        }
        const weightByDomain = new Map(interests.map((i) => [i.name, i.weight]));
        const scored = candidates.map((candidate, index) => {
          const judgement = judgementsByIndex.get(index)!;
          let popularityPercentile = 0;
          for (const signal of candidate.popularity) {
            const values = valuesBySignal.get(`${signal.source}:${signal.name}`)!;
            const lower = values.filter((v) => v < signal.value).length;
            const equal = values.filter((v) => v === signal.value).length;
            popularityPercentile = Math.max(popularityPercentile, (lower + equal / 2) / values.length);
          }
          return {
            url: candidate.url,
            title: candidate.title,
            relevance: judgement.relevance,
            domain: judgement.domain,
            topic: judgement.topic.trim(),
            popularity: candidate.popularity,
            score:
              judgement.relevance * weightByDomain.get(judgement.domain)! +
              settings.scoring.popularityStrength * popularityPercentile,
          };
        });
        scored.sort((a, b) => b.score - a.score);

        const { count, maxPerDomain } = settings.selection;
        const selected: typeof scored = [];
        const reasons = new Map<(typeof scored)[number], string>();
        for (const candidate of scored) {
          const sameTopic = selected.find((s) => s.topic === candidate.topic);
          if (sameTopic) {
            reasons.set(candidate, `同じ話題の記事「${sameTopic.title}」が選定されたため`);
          } else if (selected.length >= count) {
            reasons.set(candidate, `スコアが上位${count}本に入らなかったため`);
          } else if (selected.filter((s) => s.domain === candidate.domain).length >= maxPerDomain) {
            reasons.set(candidate, `分野「${candidate.domain}」の上限(${maxPerDomain}本)に達したため`);
          } else {
            selected.push(candidate);
            reasons.set(candidate, `スコア上位${selected.length}位として選定`);
          }
        }

        selection = selectionSchema.parse({
          date,
          since: since.toISOString(),
          until: until.toISOString(),
          totalCandidates: scored.length,
          selected: selected.map((c, i) => ({
            rank: i + 1,
            url: c.url,
            title: c.title,
            score: c.score,
            domain: c.domain,
            topic: c.topic,
            popularity: c.popularity,
          })),
          candidates: scored.map((c) => ({ ...c, selected: selected.includes(c), reason: reasons.get(c)! })),
          failedSources,
        });
        filesToSave.push({
          name: "selection.json",
          mimeType: "application/json",
          content: JSON.stringify(selection, null, 2),
          folder: "day",
        });
        log(`selection: ${selection.totalCandidates} candidates, ${selection.selected.length} selected`);
      } else if (step === "summarize") {
        currentStep = "要約";
        if (selection === null) throw new Error("selection is not available");
        if (selection.selected.length === 0) throw new Error("No articles were selected");
        const jinaApiKey = env["JINA_API_KEY"] ?? "";
        if (jinaApiKey === "") throw new Error("JINA_API_KEY is not set");

        const target = selection.selected.length;
        const failedArticles: { url: string; title: string; message: string }[] = [];
        const kept: { rank: number; score: number; url: string; title: string; domain: string; topic: string; body: string }[] = [];
        const queue = [
          ...selection.selected.map((s) => ({ ...s, fallback: false })),
          ...selection.candidates
            .filter((c) => !c.selected)
            .sort((a, b) => b.score - a.score)
            .map((c) => ({ ...c, rank: 0, fallback: true })),
        ];
        let nextRank = Math.max(...selection.selected.map((s) => s.rank)) + 1;
        for (const article of queue) {
          if (article.fallback) {
            if (kept.length >= target) break;
            if (kept.some((k) => k.topic === article.topic)) continue;
            if (kept.filter((k) => k.domain === article.domain).length >= settings.selection.maxPerDomain) continue;
          }
          let body: string | null = null;
          for (let attempt = 0; ; attempt++) {
            try {
              const response = await fetchFn(`https://r.jina.ai/${article.url}`, {
                headers: { Authorization: `Bearer ${jinaApiKey}`, "X-Return-Format": "markdown", "X-Engine": "browser" },
              });
              if (!response.ok) throw new Error(`Jina Reader responded with HTTP ${response.status}`);
              const text = (await response.text()).trim();
              const [header, ...rest] = text.split("Markdown Content:");
              const targetError = /^Warning: Target URL returned error (\d+)/m.exec(header ?? "");
              if (targetError) throw new Error(`Target URL returned HTTP ${targetError[1]} via Jina Reader`);
              const content = rest.length > 0 ? rest.join("Markdown Content:").trim() : text;
              if (content === "") throw new Error("Jina Reader returned an empty body");
              body = text;
              break;
            } catch (error) {
              if (attempt >= RETRY_DELAYS_MS.length) {
                failedArticles.push({
                  url: article.url,
                  title: article.title,
                  message: error instanceof Error ? error.message : String(error),
                });
                break;
              }
              await sleep(RETRY_DELAYS_MS[attempt]!);
            }
          }
          if (body === null) continue;
          kept.push({
            rank: article.fallback ? nextRank++ : article.rank,
            score: article.score,
            url: article.url,
            title: article.title,
            domain: article.domain,
            topic: article.topic,
            body,
          });
        }
        if (kept.length === 0) {
          throw new Error(
            `No article body could be fetched: ${failedArticles.map((f) => `${f.url} (${f.message})`).join("; ")}`,
          );
        }
        kept.sort((a, b) => a.rank - b.rank);

        const summaries = await Promise.all(
          kept.map(async (article) => {
            for (let attempt = 0; ; attempt++) {
              try {
                const message = await anthropic.beta.messages
                  .stream({
                    model: settings.models.summarize,
                    max_tokens: 128000,
                    system: summarizePrompt,
                    messages: [
                      {
                        role: "user",
                        content: `# 記事のURL\n${article.url}\n\n# 元のタイトル\n${article.title}\n\n# 本文\n${article.body}`,
                      },
                    ],
                    thinking: { type: "adaptive" },
                    output_config: { effort: "high", format: betaZodOutputFormat(articleSummarySchema) },
                    betas: ["server-side-fallback-2026-07-01"],
                    fallbacks: "default",
                  })
                  .finalMessage();
                if (message.stop_reason === "refusal") {
                  throw new Error(`Claude refused the request: ${message.stop_details?.category ?? "unknown category"}`);
                }
                if (message.stop_reason === "max_tokens") throw new Error("Claude hit max_tokens");
                return articleSummarySchema.parse(message.parsed_output);
              } catch (error) {
                if (attempt >= RETRY_DELAYS_MS.length) throw error;
                await sleep(RETRY_DELAYS_MS[attempt]!);
              }
            }
          }),
        );

        const digestTitleSchema = z.object({ title: z.string().min(1) });
        let title!: string;
        for (let attempt = 0; ; attempt++) {
          try {
            const message = await anthropic.beta.messages
              .stream({
                model: settings.models.summarize,
                max_tokens: 128000,
                system: DIGEST_TITLE_PROMPT,
                messages: [{ role: "user", content: summaries.map((s) => `- ${s.title}: ${s.what}`).join("\n") }],
                thinking: { type: "adaptive" },
                output_config: { effort: "high", format: betaZodOutputFormat(digestTitleSchema) },
                betas: ["server-side-fallback-2026-07-01"],
                fallbacks: "default",
              })
              .finalMessage();
            if (message.stop_reason === "refusal") {
              throw new Error(`Claude refused the request: ${message.stop_details?.category ?? "unknown category"}`);
            }
            if (message.stop_reason === "max_tokens") throw new Error("Claude hit max_tokens");
            title = digestTitleSchema.parse(message.parsed_output).title.trim();
            if (title === "") throw new Error("Claude returned an empty digest title");
            break;
          } catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length) throw error;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }

        digest = digestSchema.parse({
          date: selection.date,
          title,
          totalCandidates: selection.totalCandidates,
          articles: kept.map((article, i) => ({
            ...summaries[i]!,
            rank: article.rank,
            score: article.score,
            domain: article.domain,
            url: article.url,
          })),
          failedSources: selection.failedSources,
          failedArticles,
        });
        filesToSave.push({
          name: "digest.json",
          mimeType: "application/json",
          content: JSON.stringify(digest, null, 2),
          folder: "day",
        });
        log(`digest: ${digest.articles.length} articles, ${digest.failedArticles.length} failed`);
      } else if (step === "slides") {
        currentStep = "スライド生成";
        if (digest === null) throw new Error("digest is not available");

        const domainOrder = interests.map((i) => i.name);
        const ordered = [...digest.articles].sort((a, b) => {
          const orderA = domainOrder.includes(a.domain) ? domainOrder.indexOf(a.domain) : domainOrder.length;
          const orderB = domainOrder.includes(b.domain) ? domainOrder.indexOf(b.domain) : domainOrder.length;
          return orderA - orderB || a.domain.localeCompare(b.domain) || b.score - a.score;
        });
        const top3 = [...digest.articles].sort((a, b) => b.score - a.score).slice(0, 3);
        const breakdown: string[] = [];
        for (const article of ordered) {
          const label = `${article.domain} ${ordered.filter((a) => a.domain === article.domain).length}`;
          if (!breakdown.includes(label)) breakdown.push(label);
        }
        const lines: string[] = [
          `# ${digest.title}`,
          "",
          `${Number(year)}年${Number(month)}月${Number(day)}日 / ${digest.totalCandidates}本の候補から${digest.articles.length}本を選定`,
          "",
          "## 注目3本",
          "",
          ...top3.map((a) => `- **${a.title}**: ${a.what}`),
          "",
          "## 分野ごとの内訳",
          "",
          breakdown.join("・"),
        ];
        for (const article of ordered) {
          lines.push(
            "",
            "---",
            "",
            `# ${article.title}`,
            "",
            `分野: ${article.domain}`,
            "",
            "## 何が起きたか",
            "",
            article.what,
            "",
            "## なぜ重要か",
            "",
            article.why_it_matters,
            "",
            "## 技術的なポイント",
            "",
            ...article.key_points.map((p) => `- ${p}`),
          );
          if (article.caveats.length > 0) lines.push("", "## 注意点・限界", "", ...article.caveats.map((c) => `- ${c}`));
          lines.push("", `元記事: ${article.url}`);
        }
        const inputText = lines.join("\n");
        if (inputText.length > GAMMA_INPUT_TEXT_MAX_LENGTH) {
          throw new Error(`Gamma inputText is too long: ${inputText.length} characters (max ${GAMMA_INPUT_TEXT_MAX_LENGTH})`);
        }
        const gammaRequest = {
          inputText,
          textMode: "generate",
          format: "presentation",
          numCards: settings.slides.numCards,
          cardSplit: "auto",
          additionalInstructions: GAMMA_ADDITIONAL_INSTRUCTIONS,
          exportAs: "pdf",
          ...(settings.slides.themeId ? { themeId: settings.slides.themeId } : {}),
          ...(settings.slides.folderId ? { folderId: settings.slides.folderId } : {}),
          textOptions: { language: "ja" },
          imageOptions: { source: "aiGenerated" },
          cardOptions: { dimensions: "16x9" },
        };

        if (dryRun) {
          slidesError = DRY_RUN_SLIDES_MESSAGE;
          filesToSave.push({
            name: "gamma-request.json",
            mimeType: "application/json",
            content: JSON.stringify(gammaRequest, null, 2),
            folder: "day",
          });
        } else {
          try {
            const gammaApiKey = env["GAMMA_API_KEY"] ?? "";
            if (gammaApiKey === "") throw new Error("GAMMA_API_KEY is not set");
            const headers = { "X-API-KEY": gammaApiKey, "Content-Type": "application/json" };

            let generationId!: string;
            for (let attempt = 0; ; attempt++) {
              try {
                const response = await fetchFn(`${GAMMA_API_BASE}/generations`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(gammaRequest),
                });
                if (!response.ok) {
                  throw new Error(`Gamma generation request failed: HTTP ${response.status} ${await response.text()}`);
                }
                const body = (await response.json()) as { generationId?: unknown };
                if (typeof body.generationId !== "string" || body.generationId === "") {
                  throw new Error("Gamma generation request returned no generationId");
                }
                generationId = body.generationId;
                break;
              } catch (error) {
                if (attempt >= RETRY_DELAYS_MS.length) throw error;
                await sleep(RETRY_DELAYS_MS[attempt]!);
              }
            }

            let completed: { gammaUrl: string; exportUrl: string; creditsDeducted: number | null } | null = null;
            for (let poll = 0; poll < GAMMA_MAX_POLLS && completed === null; poll++) {
              await sleep(GAMMA_POLL_INTERVAL_MS);
              let status!: {
                status?: string;
                gammaUrl?: string;
                exportUrl?: string;
                credits?: { deducted?: number };
                error?: { message?: string; statusCode?: number };
              };
              for (let attempt = 0; ; attempt++) {
                try {
                  const response = await fetchFn(`${GAMMA_API_BASE}/generations/${generationId}`, { headers });
                  if (!response.ok) throw new Error(`Gamma status request failed: HTTP ${response.status}`);
                  status = (await response.json()) as typeof status;
                  break;
                } catch (error) {
                  if (attempt >= RETRY_DELAYS_MS.length) throw error;
                  await sleep(RETRY_DELAYS_MS[attempt]!);
                }
              }
              if (status.status === "failed") {
                throw new Error(
                  `Gamma generation ${generationId} failed: ${status.error?.statusCode ?? "?"} ${status.error?.message ?? "unknown error"}`,
                );
              }
              if (status.status === "completed") {
                if (!status.gammaUrl) throw new Error(`Gamma generation ${generationId} has no gammaUrl`);
                if (!status.exportUrl) throw new Error(`Gamma generation ${generationId} has no exportUrl`);
                completed = {
                  gammaUrl: status.gammaUrl,
                  exportUrl: status.exportUrl,
                  creditsDeducted: status.credits?.deducted ?? null,
                };
              } else if (status.status !== "pending") {
                throw new Error(`Gamma generation ${generationId} returned unknown status: ${status.status}`);
              }
            }
            if (completed === null) {
              throw new Error(
                `Gamma generation ${generationId} did not complete within ${(GAMMA_MAX_POLLS * GAMMA_POLL_INTERVAL_MS) / 1000} seconds`,
              );
            }

            let downloaded!: Uint8Array;
            for (let attempt = 0; ; attempt++) {
              try {
                const response = await fetchFn(completed.exportUrl);
                if (!response.ok) throw new Error(`Gamma PDF download failed: HTTP ${response.status}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                if (bytes.length === 0) throw new Error("Gamma PDF download returned an empty file");
                downloaded = bytes;
                break;
              } catch (error) {
                if (attempt >= RETRY_DELAYS_MS.length) throw error;
                await sleep(RETRY_DELAYS_MS[attempt]!);
              }
            }

            slides = slidesMetaSchema.parse({
              generationId,
              gammaUrl: completed.gammaUrl,
              creditsDeducted: completed.creditsDeducted,
            });
            pdf = downloaded;
            filesToSave.push(
              { name: "slides.pdf", mimeType: "application/pdf", content: pdf, folder: "day" },
              { name: "slides.json", mimeType: "application/json", content: JSON.stringify(slides, null, 2), folder: "day" },
            );
            log(`slides: generated, credits deducted: ${completed.creditsDeducted ?? "unknown"}`);
          } catch (error) {
            slidesError = error instanceof Error ? error.message : String(error);
            log(`slides: failed: ${slidesError}`);
          }
        }
      } else {
        currentStep = "配信(保存)";
        if (selection === null || digest === null) throw new Error("selection or digest is not available");

        const markdownLines: string[] = [
          `# ${digest.title}`,
          "",
          `- 日付: ${digest.date}`,
          `- 選定: ${digest.totalCandidates}本の候補から${digest.articles.length}本`,
          `- Gamma: ${slides?.gammaUrl ?? "なし"}`,
        ];
        for (const article of [...digest.articles].sort((a, b) => a.rank - b.rank)) {
          markdownLines.push(
            "",
            `## ${article.rank}. ${article.title}`,
            "",
            `- 分野: ${article.domain}`,
            `- スコア: ${Math.round(article.score * 10) / 10}`,
            `- 元記事: ${article.url}`,
            "",
            "### 何が起きたか",
            "",
            article.what,
            "",
            "### なぜ重要か",
            "",
            article.why_it_matters,
            "",
            "### 技術的なポイント",
            "",
            ...article.key_points.map((p) => `- ${p}`),
          );
          if (article.caveats.length > 0) {
            markdownLines.push("", "### 注意点・限界", "", ...article.caveats.map((c) => `- ${c}`));
          }
        }
        if (digest.failedSources.length > 0) {
          markdownLines.push("", "## 取得できなかった情報源", "", ...digest.failedSources.map((f) => `- ${f.source}: ${f.message}`));
        }
        if (digest.failedArticles.length > 0) {
          markdownLines.push(
            "",
            "## 本文を取得できなかった記事",
            "",
            ...digest.failedArticles.map((f) => `- ${f.title} (${f.url}): ${f.message}`),
          );
        }

        const retentionStart = new Date(Date.parse(todayJst) - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
        newState = stateSchema.parse({
          runs: [
            ...state.runs.filter((r) => r.date !== date),
            { date, since: selection.since, until: selection.until },
          ]
            .filter((r) => r.date >= retentionStart)
            .sort((a, b) => a.date.localeCompare(b.date)),
          published: [
            ...state.published.filter((p) => p.date !== date),
            ...digest.articles.map((a) => ({ url: a.url, date })),
          ].filter((p) => p.date >= retentionStart),
        });

        filesToSave.push(
          { name: "selection.json", mimeType: "application/json", content: JSON.stringify(selection, null, 2), folder: "day" },
          { name: "digest.json", mimeType: "application/json", content: JSON.stringify(digest, null, 2), folder: "day" },
          { name: "digest.md", mimeType: "text/markdown", content: markdownLines.join("\n") + "\n", folder: "day" },
        );
        if (slides !== null && pdf !== null) {
          filesToSave.push(
            { name: "slides.pdf", mimeType: "application/pdf", content: pdf, folder: "day" },
            { name: "slides.json", mimeType: "application/json", content: JSON.stringify(slides, null, 2), folder: "day" },
          );
        }
        filesToSave.push({
          name: "state.json",
          mimeType: "application/json",
          content: JSON.stringify(newState, null, 2),
          folder: "root",
        });
      }

      const links = new Map<string, string>();
      for (const file of filesToSave) {
        await writeFile(join(file.folder === "root" ? outDir : localDayDir, file.name), file.content);
        if (drive === null) continue;
        const folderId = file.folder === "root" ? rootFolderId : dayFolderId;
        let existingId: string | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            const found = await drive.files.list({
              q: `name = '${file.name}' and '${folderId}' in parents and mimeType != '${FOLDER_MIME_TYPE}' and trashed = false`,
              fields: "files(id)",
              spaces: "drive",
            });
            existingId = found.data.files?.[0]?.id ?? undefined;
            break;
          } catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length) throw error;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }
        for (let attempt = 0; ; attempt++) {
          try {
            const media = {
              mimeType: file.mimeType,
              body: Readable.from([
                typeof file.content === "string" ? Buffer.from(file.content, "utf-8") : Buffer.from(file.content),
              ]),
            };
            const result = existingId
              ? await drive.files.update({ fileId: existingId, media, fields: "id,webViewLink" })
              : await drive.files.create({
                  requestBody: { name: file.name, parents: [folderId], mimeType: file.mimeType },
                  media,
                  fields: "id,webViewLink",
                });
            if (!result.data.id) throw new Error(`Failed to save ${file.name} to Drive`);
            links.set(file.name, result.data.webViewLink ?? `https://drive.google.com/file/d/${result.data.id}/view`);
            break;
          } catch (error) {
            if (attempt >= RETRY_DELAYS_MS.length) throw error;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }
      }

      if (step === "deliver") {
        currentStep = "配信(通知)";
        if (digest === null) throw new Error("digest is not available");
        const lines: string[] = [`📰 **${digest.date} Tech Digest: ${digest.title}**`, ""];
        for (const article of [...digest.articles].sort((a, b) => a.rank - b.rank)) {
          lines.push(`${article.rank}. [${article.domain}] ${article.title}`);
        }
        lines.push("");
        if (links.has("slides.pdf")) lines.push(`📄 PDF: ${links.get("slides.pdf")}`);
        if (slides !== null) lines.push(`🎞️ Gamma: ${slides.gammaUrl}`);
        if (links.has("digest.md")) lines.push(`📝 digest.md: ${links.get("digest.md")}`);
        if (digest.failedSources.length > 0) {
          lines.push("", "⚠️ 取得できなかった情報源:", ...digest.failedSources.map((f) => `- ${f.source}: ${f.message}`));
        }
        if (digest.failedArticles.length > 0) {
          lines.push(
            "",
            "⚠️ 本文を取得できなかった記事:",
            ...digest.failedArticles.map((f) => `- ${f.title} <${f.url}>: ${f.message}`),
          );
        }
        if (slidesError !== null) {
          const markdown = filesToSave.find((f) => f.name === "digest.md")!.content as string;
          lines.push(
            "",
            `⚠️ スライドを生成できなかったため、テキスト版を送ります: ${slidesError}`,
            "",
            ...markdown
              .trimEnd()
              .split("\n")
              .map((line) => line.replace(/^- 元記事: (.+)$/, "- 元記事: <$1>")),
          );
        }

        discordMessages = [];
        let current = "";
        for (const rawLine of lines) {
          for (let i = 0; i < rawLine.length || i === 0; i += DISCORD_MAX_LENGTH) {
            const piece = rawLine.slice(i, i + DISCORD_MAX_LENGTH);
            const next = current === "" ? piece : `${current}\n${piece}`;
            if (next.length <= DISCORD_MAX_LENGTH) {
              current = next;
            } else {
              if (current.trim() !== "") discordMessages.push(current);
              current = piece;
            }
          }
        }
        if (current.trim() !== "") discordMessages.push(current);

        if (dryRun) {
          await writeFile(join(localDayDir, "discord.txt"), discordMessages.join("\n\n-----\n\n"));
        } else {
          for (const content of discordMessages) {
            for (let attempt = 0; ; attempt++) {
              try {
                const response = await fetchFn(webhookUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
                });
                if (!response.ok) throw new Error(`Discord webhook failed: HTTP ${response.status}`);
                break;
              } catch (error) {
                if (attempt >= RETRY_DELAYS_MS.length) throw error;
                await sleep(RETRY_DELAYS_MS[attempt]!);
              }
            }
          }
        }
      }
    }

    if (selection === null || digest === null || newState === null) throw new Error("pipeline did not complete");
    return { date, selection, digest, slides, slidesError, state: newState, discordMessages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!dryRun && webhookUrl !== "") {
      const content = `⚠️ ${date} の Tech Digest の生成に失敗しました(工程: ${currentStep})\n${message}`.slice(
        0,
        DISCORD_MAX_LENGTH,
      );
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await fetchFn(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
            });
            if (!response.ok) throw new Error(`Discord webhook failed: HTTP ${response.status}`);
            break;
          } catch (notifyError) {
            if (attempt >= RETRY_DELAYS_MS.length) throw notifyError;
            await sleep(RETRY_DELAYS_MS[attempt]!);
          }
        }
      } catch (notifyError) {
        log(
          `failed to notify the error to Discord: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
        );
      }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2), process.env);
    console.log(`done: ${result.date} ${result.digest.title}`);
    if (result.slidesError !== null) console.warn(`slides: ${result.slidesError}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
