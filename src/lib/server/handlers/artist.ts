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
import { getEntityRedis, ENTITY_TTL_S } from './kg-cache.js';

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

  const redis = await getEntityRedis();
  const cacheKey = `entity:artist:${qid}`;
  if (redis) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
      return res.status(200).json(typeof hit === 'string' ? JSON.parse(hit) : hit);
    }
  }

  const [entity, workIds] = await Promise.all([fetchArtistEntity(qid), fetchArtistWorkIds(qid)]);
  if (!entity) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'artist not found' });
  }

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

  const payload = { entity, works };
  if (redis) await redis.set(cacheKey, JSON.stringify(payload), { ex: ENTITY_TTL_S }).catch(() => {});
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  return res.status(200).json(payload);
}
