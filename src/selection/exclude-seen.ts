import { normalizeUrl, type Candidate } from "./dedupe.js";

export function excludeSeen(
  candidates: Candidate[],
  seenUrls: readonly string[],
): Candidate[] {
  const seen = new Set(seenUrls.map(normalizeUrl));
  return candidates.filter((candidate) => !seen.has(normalizeUrl(candidate.url)));
}
