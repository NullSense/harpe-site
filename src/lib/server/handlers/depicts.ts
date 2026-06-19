/**
 * GET /api/depicts?qid=Q146 — a knowledge-graph subject ("depicts") page.
 *
 * Returns { entity, works }: the subject node (static JSON on the HF CDN) plus
 * works whose P180 depicts includes this QID. The dump /search uses the QID as a
 * token in the depicts_qids field, then we exact-match on the deserialized
 * `depicts` array (no substring collision). Cached 24h in Upstash.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { fetchSubjectEntity, fetchDumpSearch } from '@harpe/sources';
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
  const cacheKey = `entity:depicts:${qid}`;
  if (redis) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
      return res.status(200).json(typeof hit === 'string' ? JSON.parse(hit) : hit);
    }
  }

  const entity = await fetchSubjectEntity(qid);
  if (!entity) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'subject not found' });
  }

  const dataset = process.env.HARPE_DUMP_DATASET || '';
  let works: ArtItem[] = [];
  if (dataset) {
    try {
      const all = await fetchDumpSearch(dataset, qid);
      // Exact-match guard on the deserialized depicts array (no substring collision).
      works = all.filter((it) => it.depicts?.includes(qid)).slice(0, 100);
    } catch { /* dump unavailable → entity still renders, just no work grid */ }
  }

  const payload = { entity, works };
  if (redis) await redis.set(cacheKey, JSON.stringify(payload), { ex: ENTITY_TTL_S }).catch(() => {});
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  return res.status(200).json(payload);
}
