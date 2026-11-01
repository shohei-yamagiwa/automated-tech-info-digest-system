type Route = string | { status: number; body: string };

export type FetchCall = { url: string; init?: RequestInit };

export function fakeFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const fakeFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const route = routes[key] as Route;
    return typeof route === "string"
      ? new Response(route)
      : new Response(route.body, { status: route.status });
  };
  return { fetch: fakeFn as typeof fetch, calls };
}
