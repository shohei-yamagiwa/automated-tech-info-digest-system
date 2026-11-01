import { describe, expect, it, vi } from "vitest";
import { retryingFetch, withRetry } from "./retry.js";

const recordSleeps = () => {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
};

describe("withRetry", () => {
  it("成功すれば待たずに結果を返す", async () => {
    const { sleep, sleeps } = recordSleeps();

    await expect(withRetry(async () => "ok", sleep)).resolves.toBe("ok");
    expect(sleeps).toEqual([]);
  });

  it("失敗したら 2秒 → 4秒 と間隔を広げて再試行する", async () => {
    const { sleep, sleeps } = recordSleeps();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("y"))
      .mockResolvedValue("ok");

    await expect(withRetry(fn, sleep)).resolves.toBe("ok");
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("3回リトライしても失敗したら最後のエラーを投げる", async () => {
    const { sleep, sleeps } = recordSleeps();
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("down"));

    await expect(withRetry(fn, sleep)).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });
});

describe("retryingFetch", () => {
  const build = (...responses: Array<Response | Error>) => {
    const queue = [...responses];
    const base = vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (next instanceof Error) throw next;
      return next.clone();
    });
    return base;
  };

  it("5xx は再試行し、成功した応答を返す", async () => {
    const { sleep, sleeps } = recordSleeps();
    const base = build(new Response("", { status: 503 }), new Response("ok"));

    const response = await retryingFetch(base as unknown as typeof fetch, sleep)(
      "https://example.com",
    );

    expect(await response.text()).toBe("ok");
    expect(sleeps).toEqual([2000]);
  });

  it("5xx が続く場合は3回リトライした後に最後の応答を返す", async () => {
    const { sleep, sleeps } = recordSleeps();
    const base = build(new Response("", { status: 503 }));

    const response = await retryingFetch(base as unknown as typeof fetch, sleep)(
      "https://example.com",
    );

    expect(response.status).toBe(503);
    expect(base).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  it("ネットワークエラーが続く場合は最後のエラーを投げる", async () => {
    const { sleep } = recordSleeps();
    const base = build(new Error("network down"));

    await expect(
      retryingFetch(base as unknown as typeof fetch, sleep)("https://example.com"),
    ).rejects.toThrow("network down");
    expect(base).toHaveBeenCalledTimes(4);
  });

  it("404 のような 4xx は再試行しない", async () => {
    const { sleep, sleeps } = recordSleeps();
    const base = build(new Response("", { status: 404 }));

    const response = await retryingFetch(base as unknown as typeof fetch, sleep)(
      "https://example.com",
    );

    expect(response.status).toBe(404);
    expect(base).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
