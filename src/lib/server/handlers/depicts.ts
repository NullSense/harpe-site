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
import { loadSubjectPage } from '@harpe/sources';
import { isQid } from '@harpe/core';
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

  return withEntityCache(res, `entity:depicts:${qid}`, 'subject not found', () => loadSubjectPage(qid));
}
