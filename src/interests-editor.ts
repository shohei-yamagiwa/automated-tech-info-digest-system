import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export type EditorDeps = {
  rootDir?: string;
  log?: (message: string) => void;
};

const DEFAULT_PORT = 4173;
const BODY_MAX_BYTES = 1_000_000;

const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>関心領域エディタ</title>
<style>
  :root { color-scheme: light dark; --border: #8886; --accent: #2f6fed; --danger: #d0342c; --ok: #1f8a4c; }
  body { font-family: system-ui, sans-serif; max-width: 880px; margin: 0 auto; padding: 24px 16px 96px; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p.lead { margin: 0 0 20px; opacity: .7; font-size: .9rem; }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px; display: grid; gap: 8px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  label { font-size: .8rem; opacity: .7; display: grid; gap: 2px; }
  input[type=text], textarea, input[type=number] { font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; }
  input[type=text] { flex: 1; min-width: 160px; }
  textarea { width: 100%; min-height: 64px; box-sizing: border-box; resize: vertical; }
  input[type=number] { width: 90px; }
  input[type=range] { flex: 1; min-width: 160px; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: Canvas; border-top: 1px solid var(--border); }
  .bar > div { max-width: 880px; margin: 0 auto; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  #status { flex: 1; font-size: .9rem; }
  #status.error { color: var(--danger); white-space: pre-wrap; }
  #status.ok { color: var(--ok); }
</style>
</head>
<body>
<h1>関心領域エディタ</h1>
<p class="lead">config/interests.yaml を編集します。並び順はスライド内の分野の並び順になります。反映するには保存後にコミットして push してください。</p>
<div id="list"></div>
<button id="add">＋ 関心領域を追加</button>
<div class="bar"><div>
  <span id="status"></span>
  <button id="reload">読み込み直す</button>
  <button id="save" class="primary">保存</button>
</div></div>
<script>
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const saveEl = document.getElementById("save");
let interests = [];
let dirty = false;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

function markDirty() {
  dirty = true;
  setStatus("未保存の変更があります", "");
}

function render() {
  listEl.replaceChildren();
  interests.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.placeholder = "名前";
    nameInput.addEventListener("input", () => { item.name = nameInput.value; markDirty(); });
    const up = document.createElement("button");
    up.textContent = "↑";
    up.disabled = index === 0;
    up.addEventListener("click", () => { interests.splice(index - 1, 0, interests.splice(index, 1)[0]); markDirty(); render(); });
    const down = document.createElement("button");
    down.textContent = "↓";
    down.disabled = index === interests.length - 1;
    down.addEventListener("click", () => { interests.splice(index + 1, 0, interests.splice(index, 1)[0]); markDirty(); render(); });
    const remove = document.createElement("button");
    remove.textContent = "削除";
    remove.className = "danger";
    remove.addEventListener("click", () => { interests.splice(index, 1); markDirty(); render(); });
    head.append(nameInput, up, down, remove);

    const description = document.createElement("textarea");
    description.value = item.description;
    description.placeholder = "どんな記事が読みたいか";
    description.addEventListener("input", () => { item.description = description.value; markDirty(); });

    const weightRow = document.createElement("div");
    weightRow.className = "row";
    const weightLabel = document.createElement("span");
    weightLabel.textContent = "重み";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0.1";
    range.max = "2";
    range.step = "0.05";
    range.value = String(item.weight);
    const number = document.createElement("input");
    number.type = "number";
    number.min = "0.01";
    number.step = "0.05";
    number.value = String(item.weight);
    range.addEventListener("input", () => { item.weight = Number(range.value); number.value = range.value; markDirty(); });
    number.addEventListener("input", () => { item.weight = Number(number.value); range.value = number.value; markDirty(); });
    weightRow.append(weightLabel, range, number);

    card.append(head, description, weightRow);
    listEl.append(card);
  });
}

async function load() {
  const response = await fetch("/api/interests");
  const body = await response.json();
  if (!response.ok) {
    setStatus(body.error || "読み込みに失敗しました", "error");
    return;
  }
  interests = body.interests;
  dirty = false;
  setStatus("", "");
  render();
}

document.getElementById("add").addEventListener("click", () => {
  interests.push({ name: "", description: "", weight: 1 });
  markDirty();
  render();
});

document.getElementById("reload").addEventListener("click", () => {
  if (dirty && !confirm("未保存の変更を破棄して読み込み直しますか？")) return;
  load();
});

saveEl.addEventListener("click", async () => {
  saveEl.disabled = true;
  try {
    const response = await fetch("/api/interests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interests }),
    });
    const body = await response.json();
    if (!response.ok) {
      setStatus(body.error || "保存に失敗しました", "error");
      return;
    }
    interests = body.interests;
    dirty = false;
    render();
    setStatus("保存しました", "ok");
  } catch (error) {
    setStatus("保存に失敗しました: " + error.message, "error");
  } finally {
    saveEl.disabled = false;
  }
});

window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});

load();
</script>
</body>
</html>
`;

export async function runInterestsEditor(
  argv: string[],
  deps: EditorDeps = {},
) {
  let port = DEFAULT_PORT;
  for (const arg of argv) {
    if (arg.startsWith("--port=")) {
      const value = arg.slice("--port=".length);
      port = Number(value);
      if (!/^\d+$/.test(value) || port > 65535) {
        throw new Error(`--port must be an integer between 0 and 65535: ${value}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const rootDir = deps.rootDir ?? process.cwd();
  const log = deps.log ?? ((message: string) => console.log(message));
  const interestsPath = join(rootDir, "config/interests.yaml");
  const interestsFileSchema = z.strictObject({
    interests: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1),
          description: z.string().trim().min(1),
          weight: z.number().positive(),
        }),
      )
      .min(1)
      .refine((items) => new Set(items.map((i) => i.name)).size === items.length, {
        message: "interest names must be unique",
      }),
  });

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const isHtml = typeof body === "string";
      res.writeHead(status, {
        "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(isHtml ? body : JSON.stringify(body));
    };

    try {
      const allowedHosts = [`127.0.0.1:${(server.address() as AddressInfo).port}`, `localhost:${(server.address() as AddressInfo).port}`];
      if (!allowedHosts.includes(req.headers.host ?? "")) {
        send(403, { error: "forbidden host" });
        return;
      }

      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      if (path === "/") {
        if (req.method !== "GET") {
          send(405, { error: "method not allowed" });
          return;
        }
        send(200, PAGE_HTML);
        return;
      }

      if (path !== "/api/interests") {
        send(404, { error: "not found" });
        return;
      }

      if (req.method === "GET") {
        let loaded;
        try {
          loaded = interestsFileSchema.parse(parseYaml(await readFile(interestsPath, "utf-8")));
        } catch (error) {
          send(500, { error: `config/interests.yaml を読み込めません: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
        send(200, loaded);
        return;
      }

      if (req.method === "PUT") {
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          send(415, { error: "Content-Type must be application/json" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > BODY_MAX_BYTES) {
            send(413, { error: "request body too large" });
            req.destroy();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          send(400, { error: "invalid JSON" });
          return;
        }
        const parsed = interestsFileSchema.safeParse(payload);
        if (!parsed.success) {
          const messages = parsed.error.issues.map((issue) => {
            const [, index, field] = issue.path;
            return typeof index === "number"
              ? `${index + 1}番目の関心領域 ${String(field ?? "")}: ${issue.message}`
              : issue.message;
          });
          send(422, { error: messages.join("\n") });
          return;
        }
        const tmpPath = `${interestsPath}.tmp`;
        await writeFile(tmpPath, stringifyYaml(parsed.data, { lineWidth: 0 }));
        await rename(tmpPath, interestsPath);
        log(`saved ${parsed.data.interests.length} interests to ${interestsPath}`);
        send(200, parsed.data);
        return;
      }

      send(405, { error: "method not allowed" });
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(500, { error: "internal error" });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  log(`interests editor: ${url}`);
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runInterestsEditor(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
