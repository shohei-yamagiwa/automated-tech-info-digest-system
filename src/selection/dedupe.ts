export type PopularitySignal = {
  source: string;
  name: string;
  value: number;
};

export type Candidate = {
  url: string;
  title: string;
  popularity: PopularitySignal[];
};

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid)$/;

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}${parsed.search}`;
}

export function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    const existing = merged.get(url);
    if (existing) {
      existing.popularity.push(...candidate.popularity);
    } else {
      merged.set(url, { ...candidate, url, popularity: [...candidate.popularity] });
    }
  }
  return [...merged.values()];
}
