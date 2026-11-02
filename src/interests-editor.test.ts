import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runInterestsEditor } from "./interests-editor.js";

const INTERESTS_YAML = `interests:
  - name: A
    description: 説明A
    weight: 1.2
  - name: B
    description: 説明B
    weight: 0.8
`;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function setup(yaml: string | null = INTERESTS_YAML) {
  const rootDir = await mkdtemp(join(tmpdir(), "editor-root-"));
  await mkdir(join(rootDir, "config"));
  if (yaml !== null) await writeFile(join(rootDir, "config/interests.yaml"), yaml);
  const logs: string[] = [];
  const editor = await runInterestsEditor(["--port=0"], { rootDir, log: (m) => logs.push(m) });
  closers.push(editor.close);
  const put = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    fetch(`${editor.url}api/interests`, {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { rootDir, logs, editor, put, file: () => readFile(join(rootDir, "config/interests.yaml"), "utf-8") };
}

function rawRequest(url: string, host: string, path = "/api/interests") {
  const { port } = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("interests editor", () => {
  it("serves the editor page", async () => {
    const t = await setup();
    const res = await fetch(t.editor.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("関心領域エディタ");
  });

  it("returns the current interests in file order", async () => {
    const t = await setup();
    const res = await fetch(`${t.editor.url}api/interests`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      interests: [
        { name: "A", description: "説明A", weight: 1.2 },
        { name: "B", description: "説明B", weight: 0.8 },
      ],
    });
  });

  it("saves edits, reorders and trims, and writes YAML that reads back identically", async () => {
    const t = await setup();
    const res = await t.put({
      interests: [
        { name: " C ", description: " 新しい説明 ", weight: 1.5 },
        { name: "A", description: "説明A", weight: 0.25 },
      ],
    });
    expect(res.status).toBe(200);
    const expected = {
      interests: [
        { name: "C", description: "新しい説明", weight: 1.5 },
        { name: "A", description: "説明A", weight: 0.25 },
      ],
    };
    expect(await res.json()).toEqual(expected);
    expect(parseYaml(await t.file())).toEqual(expected);
    expect(await (await fetch(`${t.editor.url}api/interests`)).json()).toEqual(expected);
    expect(t.logs.some((m) => m.startsWith("saved 2 interests"))).toBe(true);
  });

  it("does not fold long Japanese descriptions across lines", async () => {
    const t = await setup();
    const description = "あ".repeat(200);
    await t.put({ interests: [{ name: "A", description, weight: 1 }] });
    expect(await t.file()).toContain(`description: ${description}\n`);
  });

  it("leaves no temporary file behind", async () => {
    const t = await setup();
    await t.put({ interests: [{ name: "A", description: "d", weight: 1 }] });
    expect(readdirSync(join(t.rootDir, "config"))).toEqual(["interests.yaml"]);
  });

  it.each<[string, unknown]>([
    ["no interests", { interests: [] }],
    ["a blank name", { interests: [{ name: "  ", description: "d", weight: 1 }] }],
    ["a blank description", { interests: [{ name: "A", description: "", weight: 1 }] }],
    ["a zero weight", { interests: [{ name: "A", description: "d", weight: 0 }] }],
    ["a negative weight", { interests: [{ name: "A", description: "d", weight: -1 }] }],
    ["a non-numeric weight", { interests: [{ name: "A", description: "d", weight: "1" }] }],
    ["a NaN weight serialized as null", { interests: [{ name: "A", description: "d", weight: null }] }],
    [
      "duplicate names",
      {
        interests: [
          { name: "A", description: "d", weight: 1 },
          { name: " A", description: "d", weight: 1 },
        ],
      },
    ],
    ["an unknown field", { interests: [{ name: "A", description: "d", weight: 1, extra: true }] }],
    ["an unknown top-level key", { interests: [{ name: "A", description: "d", weight: 1 }], selection: {} }],
    ["a missing interests key", {}],
  ])("rejects %s without touching the file", async (_label, body) => {
    const t = await setup();
    const res = await t.put(body);
    expect(res.status).toBe(422);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    expect(await t.file()).toBe(INTERESTS_YAML);
  });

  it("points at the offending interest in the error message", async () => {
    const t = await setup();
    const res = await t.put({
      interests: [
        { name: "A", description: "d", weight: 1 },
        { name: "B", description: "d", weight: 0 },
      ],
    });
    expect(((await res.json()) as { error: string }).error).toContain("2番目の関心領域 weight");
  });

  it("rejects malformed JSON", async () => {
    const t = await setup();
    const res = await t.put("{not json");
    expect(res.status).toBe(400);
    expect(await t.file()).toBe(INTERESTS_YAML);
  });

  it("rejects a PUT that is not declared as JSON, which blocks cross-site form posts", async () => {
    const t = await setup();
    const res = await t.put(
      JSON.stringify({ interests: [{ name: "X", description: "d", weight: 1 }] }),
      { "Content-Type": "text/plain" },
    );
    expect(res.status).toBe(415);
    expect(await t.file()).toBe(INTERESTS_YAML);
  });

  it("rejects an oversized body", async () => {
    const t = await setup();
    const res = await t
      .put({ interests: [{ name: "A", description: "x".repeat(1_100_000), weight: 1 }] })
      .catch(() => null);
    if (res !== null) expect(res.status).toBe(413);
    expect(await t.file()).toBe(INTERESTS_YAML);
  });

  it("rejects requests whose Host header is not the local address, which blocks DNS rebinding", async () => {
    const t = await setup();
    expect(await rawRequest(t.editor.url, "evil.example")).toBe(403);
    expect(await rawRequest(t.editor.url, "evil.example", "/")).toBe(403);
    const { port } = new URL(t.editor.url);
    expect(await rawRequest(t.editor.url, `localhost:${port}`)).toBe(200);
  });

  it("reports a broken or missing config file instead of crashing", async () => {
    for (const yaml of ["interests: []\n", "interests: [", null]) {
      const t = await setup(yaml);
      const res = await fetch(`${t.editor.url}api/interests`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain("config/interests.yaml");
    }
  });

  it("can replace a broken config file with a valid one", async () => {
    const t = await setup("interests: [");
    const res = await t.put({ interests: [{ name: "A", description: "d", weight: 1 }] });
    expect(res.status).toBe(200);
    expect((await fetch(`${t.editor.url}api/interests`)).status).toBe(200);
  });

  it("answers 404 for unknown paths and 405 for unsupported methods", async () => {
    const t = await setup();
    expect((await fetch(`${t.editor.url}nope`)).status).toBe(404);
    expect((await fetch(`${t.editor.url}api/interests`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(t.editor.url, { method: "POST" })).status).toBe(405);
  });

  it("rejects unknown or invalid arguments", async () => {
    await expect(runInterestsEditor(["--nope"])).rejects.toThrow("Unknown argument: --nope");
    for (const value of ["abc", "-1", "70000", ""]) {
      await expect(runInterestsEditor([`--port=${value}`])).rejects.toThrow("--port must be an integer");
    }
  });

  it("fails to start when the port is already in use", async () => {
    const t = await setup();
    const { port } = new URL(t.editor.url);
    await expect(runInterestsEditor([`--port=${port}`], { rootDir: t.rootDir, log: () => {} })).rejects.toThrow();
  });

  it("accepts the interests config in the repository and writes it back with the same content", async () => {
    const original = readFileSync("config/interests.yaml", "utf-8");
    const t = await setup(original);
    const loaded = (await (await fetch(`${t.editor.url}api/interests`)).json()) as unknown;
    expect((await t.put(loaded)).status).toBe(200);
    expect(parseYaml(await t.file())).toEqual(parseYaml(original));
  });
});
