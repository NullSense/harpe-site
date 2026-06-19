/**
 * GET /api/item?id=<id> — resolve a single artwork by its stable id.
 *
 * Powers the by-id deep-link fallback: a shared link ?q=…&v=<id> must open that
 * exact card even when it isn't in the (non-deterministic, live-source) result
 * set. Routes by the id's source prefix — commons-<pageid> → Commons API, every
 * other prefix → that source's HF dump row by exact id. Returns { item } or 404.
 * Immutable per id, so it edge-caches hard.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { fetchItemById } from '@harpe/sources';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
  // Ids are "<source>-<token>" (token: numeric or a QID). Cheap shape guard before
  // any upstream call — rejects junk without spending a rate-limit slot upstream.
  if (!/^[a-z]+-[A-Za-z0-9]+$/.test(id)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Missing or invalid ?id=' });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    await rateLimit(ip);
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }

  const item = await fetchItemById(id).catch(() => null);
  if (!item) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'item not found' });
  }
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=86400');
  return res.status(200).json({ item });
}
