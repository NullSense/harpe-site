/**
 * /api/art-page?q=<query>&page=<n>
 *
 * Deeper pages of the dump-backed deep index for infinite scroll. Page 0 is served
 * by /api/art-stream (federated live + dump); pages ≥1 here are DUMP-ONLY (the live
 * APIs already gave their sample on page 0). Returns ranked, de-duplicated ArtItems
 * plus `hasMore` (any dump source still has rows beyond this page) and `total` (the
 * summed HF match counts) so the client can drive infinite scroll and show a count.
 *
 * Response: { items: ArtItem[], page: number, hasMore: boolean, total: number }
 * This response shape is the fixed contract the client (lib/artPage.ts) codes
 * against — keep it stable.
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { rankResults, qualityScore, type ArtItem } from '@harpe/core';
import { fetchDumpPage } from '@harpe/sources';

const PAGE_SIZE = 100; // matches DUMP_PER_SOURCE — HF /filter's per-request max

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Missing or empty ?q= parameter' });
  }
  // Clamp into [1, 50]: non-integer/NaN/<1 → 1; >50 → 50 (the nearest valid page,
  // never silently the wrong one).
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : 1;
  const page = !Number.isInteger(pageRaw) || pageRaw < 1 ? 1 : Math.min(pageRaw, 50);

  if (!(await enforceRateLimit(req, res))) return;

  const dataset = process.env.HARPE_DUMP_DATASET || ''; // shared dump dataset (matches artist.ts)
  if (!dataset) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ items: [], page, hasMore: false, total: 0 });
  }

  let result: { items: ArtItem[]; hasMore: boolean; total: number };
  try {
    result = await fetchDumpPage(dataset, q, page);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Dump page fetch failed' });
  }

  // Cap the page to PAGE_SIZE — the pool is up to 13×100 rows, but a page should be
  // a bounded slice (the client appends pages, so depth comes from more pages).
  const ranked = rankResults(result.items, q, { qualityOf: (it) => qualityScore(it, q) }).slice(0, PAGE_SIZE);
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ items: ranked, page, hasMore: result.hasMore, total: result.total });
}
