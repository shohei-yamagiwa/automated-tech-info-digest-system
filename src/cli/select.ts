import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseInterests, parseSettings, parseSources } from "../config/config.js";
import { retryingFetch } from "../http/retry.js";
import { anthropicStructuredCall } from "../selection/anthropic.js";
import { judgeRelevance } from "../selection/judge.js";
import { runSelection } from "../selection/run.js";

const OUT_DIR = "out";
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const sinceArg = process.argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);
if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since: ${sinceArg}`);

const [interests, sources, settings] = await Promise.all([
  readFile("config/interests.yaml", "utf-8").then(parseInterests),
  readFile("config/sources.yaml", "utf-8").then(parseSources),
  readFile("config/settings.yaml", "utf-8").then(parseSettings),
]);

const call = anthropicStructuredCall(new Anthropic(), settings.models.relevance);

const { selection, failures } = await runSelection({
  sources,
  interests,
  settings,
  since,
  seenUrls: [],
  fetch: retryingFetch(fetch),
  qiitaToken: process.env["QIITA_TOKEN"],
  judge: (candidates, interests) => judgeRelevance(candidates, interests, call),
});

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/selection.json`, JSON.stringify(selection, null, 2));

console.log(`${selection.totalCandidates} candidates, ${selection.selected.length} selected`);
for (const failure of failures) console.warn(`source failed: ${failure.source}: ${failure.message}`);
