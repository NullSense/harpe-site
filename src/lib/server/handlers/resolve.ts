/**
 * GET /api/resolve?q=<query> — knowledge-graph entity detection for the search box.
 *
 * Returns { entity: { kind:'subject', qid } | null }. When a query matches a KG
 * subject ("Joan of Arc"), the client opens its subject page (works depicting it +
 * the enriched card) instead of a literal text search. Cheap: a memoised static-JSON
 * lookup on the HF CDN. Artist queries deliberately return null so they keep the
 * tuned federated text-search ranking (famous-works-first).
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { resolveQueryEntity } from '@harpe/sources';

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
    return res.status(200).json({ entity: null });
  }

  let entity: Awaited<ReturnType<typeof resolveQueryEntity>> = null;
  try {
    entity = await resolveQueryEntity(q);
  } catch {
    entity = null; // best-effort: a resolver miss just means a normal search
  }
  // Safe to cache: the index changes only on a re-ingest.
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ entity });
}
