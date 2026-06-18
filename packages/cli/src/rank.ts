/**
 * Rank ArtItems by relevance (query-token overlap) first, then resolution.
 * Ported from harpe/rank.py. Updated to use ArtItem (was Candidate).
 *
 * NOTE: The primary ranking logic now lives in @harpe/core (rankResults /
 * qualityScore). This module provides the legacy CLI-style rank() shim used
 * by rank.test.ts and the CLI sources wrapper for backwards-compatible testing.
 * New code should prefer rankResults() from @harpe/core.
 */
import type { ArtItem } from '@harpe/core';

const STOP = new Set([
  'the', 'and', 'of', 'his', 'her', 'its', 'from', 'with', 'for', 'are',
  'was', 'painting', 'original',
]);

/** Split a query into lowercase tokens, dropping stopwords and short tokens. */
export function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Pixel area of an ArtItem (from explicit width×height or 0). */
function area(it: ArtItem): number {
  if (it.width && it.height) return it.width * it.height;
  return 0;
}

/** Stable dedup key for an ArtItem (fullUrl, or thumbUrl as fallback). */
function dedupKey(it: ArtItem): string {
  return it.fullUrl || it.thumbUrl;
}

/**
 * Most relevant first, biggest resolution of each work first, deduped by URL.
 *
 * A relevance floor trims noise only on a strong (>=4 query-token) match — weak
 * queries keep everything so a one-word search still shows results.
 */
export function rank(q: string, items: ArtItem[]): ArtItem[] {
  const toks = tokens(q);
  const scored: Array<[number, ArtItem]> = items.map((it) => {
    const hay = `${it.title} ${it.artist}`.toLowerCase();
    const rel = toks.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    return [rel, it];
  });

  scored.sort(([relA, iA], [relB, iB]) => {
    if (relB !== relA) return relB - relA;
    return area(iB) - area(iA);
  });

  if (scored.length === 0) return [];

  const maxRel = scored[0][0];
  const floor = maxRel >= 4 ? 2 : 0;

  const seen = new Set<string>();
  const out: ArtItem[] = [];
  for (const [rel, it] of scored) {
    if (rel < floor) continue;
    const key = dedupKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
