export type Sleep = (ms: number) => Promise<void>;

const RETRY_DELAYS_MS = [2000, 4000, 8000];

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RetryableStatus extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: Sleep = defaultSleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

export function retryingFetch(fetchFn: typeof fetch, sleep?: Sleep): typeof fetch {
  const retrying = async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await withRetry(async () => {
        const response = await fetchFn(input, init);
        if (response.status >= 500 || response.status === 429) {
          throw new RetryableStatus(response);
        }
        return response;
      }, sleep);
    } catch (error) {
      if (error instanceof RetryableStatus) return error.response;
      throw error;
    }
  };
  return retrying as typeof fetch;
}
