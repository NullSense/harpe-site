/**
 * Rank candidates by relevance (query-token overlap) first, then resolution.
 * Ported from harpe/rank.py.
 */
import type { Candidate } from './models.js';

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

/**
 * Most relevant first, biggest scan of each work first, deduped by source URL.
 *
 * A relevance floor trims noise only on a strong (>=4 query-token) match — weak
 * queries keep everything so a one-word search still shows results.
 */
export function rank(q: string, cands: Candidate[]): Candidate[] {
  const toks = tokens(q);
  const scored: Array<[number, Candidate]> = cands.map((c) => {
    const hay = `${c.title} ${c.artist}`.toLowerCase();
    const rel = toks.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    return [rel, c];
  });

  scored.sort(([relA, cA], [relB, cB]) => {
    if (relB !== relA) return relB - relA;
    return cB.area - cA.area;
  });

  if (scored.length === 0) return [];

  const maxRel = scored[0][0];
  const floor = maxRel >= 4 ? 2 : 0;

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const [rel, c] of scored) {
    if (rel < floor) continue;
    const key = c.spec || c.thumb;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
