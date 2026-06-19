/**
 * GET /api/artist?qid=Q41406 — a knowledge-graph artist page.
 *
 * Returns { entity, works }: the artist node (static JSON on the HF CDN) plus a
 * grid of their works pulled from the dump deep-index. No query engine, no paid
 * infra — static CDN file + the existing dump /search, cached 24h in Upstash.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { fetchArtistEntity, fetchArtistWorkIds, fetchDumpSearch } from '@harpe/sources';
import { isQid } from '@harpe/core';
import type { ArtItem } from '@harpe/core';
import { withEntityCache } from './kg-cache.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const qid = typeof req.query.qid === 'string' ? req.query.qid.trim() : '';
  if (!isQid(qid)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Missing or invalid ?qid= (expected Q…)' });
  }

  if (!(await enforceRateLimit(req, res))) return;

  return withEntityCache(res, `entity:artist:${qid}`, 'artist not found', async () => {
    const [entity, workIds] = await Promise.all([fetchArtistEntity(qid), fetchArtistWorkIds(qid)]);
    if (!entity) return null;

    // Works: one dump /search on the artist label, kept to the known work-id set.
    const dataset = process.env.HARPE_DUMP_DATASET || '';
    let works: ArtItem[] = [];
    if (dataset && workIds.length > 0) {
      const idSet = new Set(workIds);
      try {
        const all = await fetchDumpSearch(dataset, entity.labelEn);
        works = all.filter((it) => idSet.has(it.id)).slice(0, 100);
      } catch { /* dump unavailable → entity still renders, just no work grid */ }
    }
    return { entity, works };
  });
}
