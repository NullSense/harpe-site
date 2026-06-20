/**
 * GET /api/artist?qid=Q41406 — a knowledge-graph artist page.
 *
 * Returns { entity, works }: the artist node (static JSON on the HF CDN) plus a
 * grid of their works pulled from the dump deep-index. No query engine, no paid
 * infra — static CDN file + the existing dump /search, cached 24h in Upstash.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { loadArtistPage } from '@harpe/sources';
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

  return withEntityCache(res, `entity:artist:${qid}`, 'artist not found', () => loadArtistPage(qid));
}
