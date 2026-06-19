/**
 * Client-side helper for /api/art-page — the dump-backed deep-index pagination
 * endpoint used by Finder's infinite scroll once the live-API pool is exhausted.
 *
 * Each page returns up to DUMP_PER_SOURCE (100) rows per source. The response
 * also carries a `total` estimate (sum of HF match counts) and `hasMore` so the
 * client knows whether to keep going.
 */

export interface ArtPageResponse {
  items: unknown[];      // raw ArtItem shapes; caller runs normalizeArt() on each
  page: number;
  hasMore: boolean;
  total: number;
}

/**
 * Fetch one dump page from /api/art-page.
 *
 * @param q       The search query (will be URI-encoded).
 * @param page    0-based page number on the caller side; internally we pass page≥1
 *                because page 0 is served by the SSE stream. Callers start at 1.
 * @param signal  AbortSignal from the caller's AbortController — cancels in-flight
 *                requests when a new search starts.
 * @returns       Parsed response, or throws on network / HTTP errors.
 */
export async function fetchArtPage(
  q: string,
  page: number,
  signal?: AbortSignal,
): Promise<ArtPageResponse> {
  const url = `/api/art-page?q=${encodeURIComponent(q)}&page=${page}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const json = await res.json() as { error?: string };
      if (json.error) message = json.error;
    } catch { /* ignore parse errors */ }
    throw new Error(message);
  }
  return res.json() as Promise<ArtPageResponse>;
}
