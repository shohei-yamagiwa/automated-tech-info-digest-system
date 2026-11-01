import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseSettings } from "../config/config.js";
import { retryingFetch } from "../http/retry.js";
import { selectionSchema } from "../schemas/selection.js";
import { anthropicStructuredCall } from "../selection/anthropic.js";
import { runSummarize } from "../summarize/run.js";

const OUT_DIR = "out";

const jinaApiKey = process.env["JINA_API_KEY"];
if (!jinaApiKey) throw new Error("JINA_API_KEY is not set");

const settings = parseSettings(await readFile("config/settings.yaml", "utf-8"));
const selection = selectionSchema.parse(
  JSON.parse(await readFile(`${OUT_DIR}/selection.json`, "utf-8")),
);

const { digest, failures } = await runSummarize({
  selection,
  settings,
  summarizePrompt: await readFile("prompts/summarize.md", "utf-8"),
  fetch: retryingFetch(fetch),
  jinaApiKey,
  call: anthropicStructuredCall(new Anthropic(), settings.models.summarize),
});

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/digest.json`, JSON.stringify(digest, null, 2));

console.log(`${digest.articles.length} articles summarized: ${digest.title}`);
for (const failure of failures) console.warn(`article failed: ${failure.url}: ${failure.message}`);
