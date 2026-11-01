import { describe, expect, it, vi } from "vitest";
import { parseSettings } from "../config/config.js";
import { digestSchema } from "../schemas/digest.js";
import type { Selection } from "../schemas/selection.js";
import type { StructuredCall } from "../selection/judge.js";
import { runSummarize, type SummarizeInput } from "./run.js";

type Item = { id: string; score: number; domain?: string; topic?: string };

const urlOf = (id: string) => `https://example.com/${id}`;

const makeSelection = (selected: Item[], others: Item[] = []): Selection => {
  const record = (item: Item, isSelected: boolean) => ({
    url: urlOf(item.id),
    title: `title ${item.id}`,
    relevance: 80,
    domain: item.domain ?? "AI/LLM",
    topic: item.topic ?? `topic-${item.id}`,
    score: item.score,
    selected: isSelected,
    reason: "r",
  });
  return {
    totalCandidates: selected.length + others.length,
    selected: selected.map((item, i) => ({
      rank: i + 1,
      url: urlOf(item.id),
      title: `title ${item.id}`,
      score: item.score,
      domain: item.domain ?? "AI/LLM",
      topic: item.topic ?? `topic-${item.id}`,
      popularity: [],
    })),
    candidates: [
      ...selected.map((i) => record(i, true)),
      ...others.map((i) => record(i, false)),
    ],
  };
};

// script[id] の要素を呼び出しごとに順に消費する。number は HTTP エラー、string は本文。最後の要素は繰り返す。
const scriptedJina = (script: Record<string, Array<number | string>>) => {
  const used: Record<string, number> = {};
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const id = url.split("/").pop()!;
    const steps = script[id] ?? [`body of ${id}`];
    const step = steps[Math.min(used[id] ?? 0, steps.length - 1)]!;
    used[id] = (used[id] ?? 0) + 1;
    return typeof step === "number"
      ? new Response("error", { status: step })
      : new Response(step);
  }) as typeof fetch;
  return { fetch: fn, calls };
};

const isSummaryRequest = (schema: Record<string, unknown>) =>
  "what" in (schema["properties"] as Record<string, unknown>);

const idFromUser = (user: string) => /example\.com\/(\w+)/.exec(user)![1]!;

const goodSummary = (id: string) => ({
  title: `日本語タイトル ${id}`,
  what: `what ${id}`,
  why_it_matters: `why ${id}`,
  key_points: [`point ${id}`],
  caveats: [],
});

const defaultCall = (): StructuredCall =>
  vi.fn<StructuredCall>(async ({ schema, user }) =>
    isSummaryRequest(schema) ? goodSummary(idFromUser(user)) : { title: "今日の見出し" },
  );

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

const baseInput = (
  selection: Selection,
  overrides: Partial<SummarizeInput> = {},
): SummarizeInput => ({
  selection,
  settings: parseSettings("{}"),
  summarizePrompt: "SUMMARIZE PROMPT",
  fetch: scriptedJina({}).fetch,
  jinaApiKey: "jina-key",
  call: defaultCall(),
  sleep,
  ...overrides,
});

const threeSelected = () =>
  makeSelection([
    { id: "a", score: 90 },
    { id: "b", score: 80 },
    { id: "c", score: 70 },
  ]);

describe("runSummarize: 正常系", () => {
  it("選定結果の順位・スコア・分野・URL・候補総数をそのまま書き写し、要約と見出しを付ける", async () => {
    const selection = makeSelection(
      [
        { id: "a", score: 90, domain: "AI/LLM" },
        { id: "b", score: 80, domain: "形式手法" },
      ],
      [{ id: "x", score: 10 }, { id: "y", score: 5 }],
    );

    const { digest, failures } = await runSummarize(baseInput(selection));

    expect(failures).toEqual([]);
    expect(digestSchema.safeParse(digest).success).toBe(true);
    expect(digest.title).toBe("今日の見出し");
    expect(digest.totalCandidates).toBe(4);
    expect(digest.articles).toEqual([
      {
        rank: 1,
        score: 90,
        url: urlOf("a"),
        domain: "AI/LLM",
        ...goodSummary("a"),
      },
      {
        rank: 2,
        score: 80,
        url: urlOf("b"),
        domain: "形式手法",
        ...goodSummary("b"),
      },
    ]);
  });

  it("Jina Reader に API キーつきで Markdown を要求する", async () => {
    const jina = scriptedJina({});

    await runSummarize(baseInput(threeSelected(), { fetch: jina.fetch }));

    expect(jina.calls.map((c) => c.url).sort()).toEqual([
      `https://r.jina.ai/${urlOf("a")}`,
      `https://r.jina.ai/${urlOf("b")}`,
      `https://r.jina.ai/${urlOf("c")}`,
    ]);
    const headers = jina.calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer jina-key");
    expect(headers["X-Return-Format"]).toBe("markdown");
  });

  it("記事ごとに1回、要約のプロンプトと本文・URLを渡して Claude を呼ぶ", async () => {
    const call = defaultCall();

    await runSummarize(baseInput(threeSelected(), { call }));

    const summaryRequests = vi
      .mocked(call)
      .mock.calls.map((c) => c[0])
      .filter((r) => isSummaryRequest(r.schema));
    expect(summaryRequests).toHaveLength(3);
    for (const request of summaryRequests) {
      const id = idFromUser(request.user);
      expect(request.system).toBe("SUMMARIZE PROMPT");
      expect(request.user).toContain(urlOf(id));
      expect(request.user).toContain(`body of ${id}`);
    }
  });

  it("見出しは全記事の要約がそろった後に、別の呼び出しで1回だけ生成する", async () => {
    const call = defaultCall();

    await runSummarize(baseInput(threeSelected(), { call }));

    const requests = vi.mocked(call).mock.calls.map((c) => c[0]);
    expect(requests).toHaveLength(4);
    expect(isSummaryRequest(requests[3]!.schema)).toBe(false);
    expect(requests[3]!.user).toContain("日本語タイトル a");
    expect(requests[3]!.user).toContain("what c");
  });

  it("本文取得の成功時は、選定外の候補の本文を取得しない", async () => {
    const jina = scriptedJina({});
    const selection = makeSelection([{ id: "a", score: 90 }], [{ id: "x", score: 10 }]);

    await runSummarize(baseInput(selection, { fetch: jina.fetch }));

    expect(jina.calls).toHaveLength(1);
  });

  it("要約の完了順が前後しても、記事は順位の昇順に並ぶ", async () => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) => {
      if (!isSummaryRequest(schema)) return { title: "t" };
      const id = idFromUser(user);
      await new Promise((resolve) => setTimeout(resolve, id === "a" ? 30 : 0));
      return goodSummary(id);
    });

    const { digest } = await runSummarize(baseInput(threeSelected(), { call }));

    expect(digest.articles.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("b"), urlOf("c")]);
  });

  it("注意点が空の配列でも、複数あっても受け入れる", async () => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) => {
      if (!isSummaryRequest(schema)) return { title: "t" };
      const id = idFromUser(user);
      return { ...goodSummary(id), caveats: id === "a" ? ["c1", "c2"] : [] };
    });

    const { digest } = await runSummarize(baseInput(threeSelected(), { call }));

    expect(digest.articles[0]?.caveats).toEqual(["c1", "c2"]);
    expect(digest.articles[1]?.caveats).toEqual([]);
  });

  it("入力の selection を書き換えない", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }],
      [{ id: "x", score: 10 }],
    );
    const snapshot = structuredClone(selection);

    await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(selection).toEqual(snapshot);
  });
});

describe("runSummarize: 本文取得のリトライ", () => {
  it("失敗しても 2秒 → 4秒 の間隔で再試行し、成功すれば通常どおり扱う", async () => {
    sleeps.length = 0;
    const jina = scriptedJina({ a: [503, 503, "recovered body"] });

    const { digest, failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }]), { fetch: jina.fetch }),
    );

    expect(sleeps).toEqual([2000, 4000]);
    expect(failures).toEqual([]);
    expect(digest.articles).toHaveLength(1);
  });

  it("3回リトライしても失敗した記事は諦める(2秒 → 4秒 → 8秒)", async () => {
    sleeps.length = 0;
    const jina = scriptedJina({ b: [503] });

    const { digest, failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }, { id: "b", score: 80 }]), {
        fetch: jina.fetch,
      }),
    );

    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(jina.calls.filter((c) => c.url.endsWith("/b"))).toHaveLength(4);
    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a")]);
    expect(failures).toEqual([
      { url: urlOf("b"), title: "title b", message: expect.stringContaining("503") },
    ]);
  });

  it("本文が空の応答は失敗として扱う", async () => {
    const jina = scriptedJina({ b: ["   \n"] });

    const { digest, failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }, { id: "b", score: 80 }]), {
        fetch: jina.fetch,
      }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a")]);
    expect(failures[0]?.message).toContain("empty");
  });

  it("Jina Reader が HTTP 200 で返す「取得先がエラー」の警告は失敗として扱う", async () => {
    const errorPage = [
      "Title: Example Domain",
      "URL Source: https://example.com/b",
      "Warning: Target URL returned error 404: Not Found",
      "Markdown Content:",
      "This domain is for use in documentation examples.",
    ].join("\n\n");
    const jina = scriptedJina({ b: [errorPage] });

    const { digest, failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }, { id: "b", score: 80 }]), {
        fetch: jina.fetch,
      }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a")]);
    expect(failures[0]?.message).toContain("404");
  });

  it("記事の本文中に警告と同じ文言があっても失敗扱いにしない", async () => {
    const article = [
      "Title: HTTP errors explained",
      "URL Source: https://example.com/a",
      "Markdown Content:",
      "Warning: Target URL returned error 404 is shown by some proxies.",
    ].join("\n\n");

    const { failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }]), {
        fetch: scriptedJina({ a: [article] }).fetch,
      }),
    );

    expect(failures).toEqual([]);
  });

  it("ネットワークエラーも失敗として扱う", async () => {
    const failing = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/b")) throw new Error("network down");
      return new Response("body");
    }) as typeof fetch;

    const { failures } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }, { id: "b", score: 80 }]), {
        fetch: failing,
      }),
    );

    expect(failures[0]?.message).toBe("network down");
  });
});

describe("runSummarize: 繰り上げ", () => {
  it("本文取得に失敗した記事の代わりに、選定外の最上位の候補を繰り上げる", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }],
      [{ id: "x", score: 50 }, { id: "y", score: 40 }],
    );

    const { digest, failures } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("x")]);
    expect(failures.map((f) => f.url)).toEqual([urlOf("b")]);
  });

  it("繰り上げた記事の順位は、元の最下位の次の番号から付け、スコアはそのまま引き継ぐ", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }, { id: "c", score: 70 }],
      [{ id: "x", score: 50 }, { id: "y", score: 40 }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ a: [500], b: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => [a.url, a.rank, a.score])).toEqual([
      [urlOf("c"), 3, 70],
      [urlOf("x"), 4, 50],
      [urlOf("y"), 5, 40],
    ]);
  });

  it("候補の並びに関わらず、スコアの高い順に繰り上げる", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }],
      [{ id: "y", score: 40 }, { id: "x", score: 50 }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(digest.articles[1]?.url).toBe(urlOf("x"));
  });

  it("残っている記事と同じ話題の候補は繰り上げない", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90, topic: "T" }, { id: "b", score: 80 }],
      [{ id: "x", score: 50, topic: "T" }, { id: "y", score: 40 }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("y")]);
  });

  it("取得に失敗した記事の話題は解放され、同じ話題の候補を繰り上げられる", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80, topic: "T" }],
      [{ id: "x", score: 50, topic: "T" }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("x")]);
  });

  it("1分野あたりの上限に達している分野の候補は繰り上げない", async () => {
    const selection = makeSelection(
      [
        { id: "a", score: 90, domain: "AI" },
        { id: "b", score: 80, domain: "AI" },
        { id: "c", score: 70, domain: "Web" },
      ],
      [{ id: "x", score: 50, domain: "AI" }, { id: "y", score: 40, domain: "Web" }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, {
        settings: parseSettings("selection:\n  maxPerDomain: 2"),
        fetch: scriptedJina({ c: [500] }).fetch,
      }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("b"), urlOf("y")]);
  });

  it("失敗した記事と同じ分野の候補は、その枠が空いているので繰り上げられる", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90, domain: "AI" }, { id: "b", score: 80, domain: "AI" }],
      [{ id: "x", score: 50, domain: "AI" }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, {
        settings: parseSettings("selection:\n  maxPerDomain: 2"),
        fetch: scriptedJina({ b: [500] }).fetch,
      }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("x")]);
  });

  it("繰り上げた候補の本文取得にも失敗したら、次の候補を試して失敗を記録する", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }],
      [{ id: "x", score: 50 }, { id: "y", score: 40 }],
    );

    const { digest, failures } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500], x: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("y")]);
    expect(failures.map((f) => f.url)).toEqual([urlOf("b"), urlOf("x")]);
  });

  it("繰り上げ候補を使い切ったら、足りない分は補わず存在する記事だけで続ける", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }, { id: "c", score: 70 }],
      [{ id: "x", score: 50 }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500], c: [500] }).fetch }),
    );

    expect(digest.articles.map((a) => a.url)).toEqual([urlOf("a"), urlOf("x")]);
  });

  it("選定が元から目標本数より少ない場合は、候補を追加で繰り上げない", async () => {
    const selection = makeSelection([{ id: "a", score: 90 }], [{ id: "x", score: 50 }]);

    const { digest } = await runSummarize(baseInput(selection));

    expect(digest.articles).toHaveLength(1);
  });

  it("繰り上げでは候補の総数を変えない", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }, { id: "b", score: 80 }],
      [{ id: "x", score: 50 }],
    );

    const { digest } = await runSummarize(
      baseInput(selection, { fetch: scriptedJina({ b: [500] }).fetch }),
    );

    expect(digest.totalCandidates).toBe(3);
  });
});

describe("runSummarize: 異常系", () => {
  it("選定が0本ならエラーにする", async () => {
    await expect(runSummarize(baseInput(makeSelection([])))).rejects.toThrow(
      "No articles",
    );
  });

  it("すべての記事の本文を取得できなければエラーにする", async () => {
    const selection = makeSelection(
      [{ id: "a", score: 90 }],
      [{ id: "x", score: 50 }],
    );

    await expect(
      runSummarize(
        baseInput(selection, { fetch: scriptedJina({ a: [500], x: [500] }).fetch }),
      ),
    ).rejects.toThrow("No article body");
  });

  it("Claude の要約が一時的に失敗しても再試行して続ける", async () => {
    sleeps.length = 0;
    let failedOnce = false;
    const call = vi.fn<StructuredCall>(async ({ schema, user }) => {
      if (!isSummaryRequest(schema)) return { title: "t" };
      if (idFromUser(user) === "a" && !failedOnce) {
        failedOnce = true;
        throw new Error("overloaded");
      }
      return goodSummary(idFromUser(user));
    });

    const { digest } = await runSummarize(
      baseInput(makeSelection([{ id: "a", score: 90 }]), { call }),
    );

    expect(digest.articles).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it("Claude の要約が再試行しても失敗し続けたら、全体をエラーにする", async () => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) => {
      if (!isSummaryRequest(schema)) return { title: "t" };
      if (idFromUser(user) === "b") throw new Error("claude down");
      return goodSummary(idFromUser(user));
    });

    await expect(
      runSummarize(baseInput(threeSelected(), { call })),
    ).rejects.toThrow("claude down");
  });

  it.each([
    ["key_points が空", { key_points: [] }],
    ["key_points がない", { key_points: undefined }],
    ["why_it_matters がない", { why_it_matters: undefined }],
    ["caveats が配列でない", { caveats: "なし" }],
    ["未知のキーがある", { extra: 1 }],
  ])("要約の形式が不正(%s)なら再試行の末にエラーにする", async (_label, patch) => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) =>
      isSummaryRequest(schema)
        ? { ...goodSummary(idFromUser(user)), ...patch }
        : { title: "t" },
    );

    await expect(
      runSummarize(baseInput(makeSelection([{ id: "a", score: 90 }]), { call })),
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("見出しの生成に失敗し続けたらエラーにする", async () => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) => {
      if (isSummaryRequest(schema)) return goodSummary(idFromUser(user));
      throw new Error("title failed");
    });

    await expect(
      runSummarize(baseInput(threeSelected(), { call })),
    ).rejects.toThrow("title failed");
  });

  it("見出しが空文字なら再試行の末にエラーにする", async () => {
    const call = vi.fn<StructuredCall>(async ({ schema, user }) =>
      isSummaryRequest(schema) ? goodSummary(idFromUser(user)) : { title: "" },
    );

    await expect(
      runSummarize(baseInput(threeSelected(), { call })),
    ).rejects.toThrow();
  });
});

describe("digestSchema", () => {
  const article = (rank: number) => ({
    rank,
    score: 80,
    url: urlOf(`p${rank}`),
    domain: "AI/LLM",
    title: "t",
    what: "w",
    why_it_matters: "y",
    key_points: ["k"],
    caveats: [],
  });
  const valid = () => ({ title: "見出し", totalCandidates: 5, articles: [article(1), article(2)] });

  it("正しい形式を受け入れる", () => {
    expect(digestSchema.safeParse(valid()).success).toBe(true);
  });

  it("繰り上げで順位が飛んでいても受け入れる", () => {
    expect(
      digestSchema.safeParse({ ...valid(), articles: [article(1), article(11)] }).success,
    ).toBe(true);
  });

  it("記事が0件なら拒否する", () => {
    expect(digestSchema.safeParse({ ...valid(), articles: [] }).success).toBe(false);
  });

  it("順位が重複していたら拒否する", () => {
    expect(
      digestSchema.safeParse({ ...valid(), articles: [article(1), article(1)] }).success,
    ).toBe(false);
  });

  it("見出しが空なら拒否する", () => {
    expect(digestSchema.safeParse({ ...valid(), title: "" }).success).toBe(false);
  });

  it("URL が不正なら拒否する", () => {
    expect(
      digestSchema.safeParse({
        ...valid(),
        articles: [{ ...article(1), url: "not a url" }],
      }).success,
    ).toBe(false);
  });
});
