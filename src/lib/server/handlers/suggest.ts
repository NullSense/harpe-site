/**
 * GET /api/suggest — the KG-derived autocomplete pool (data/suggest.json on the HF
 * CDN), fame-ranked artists + subjects + movements with QIDs. The client lazy-loads
 * it once to replace its tiny static fallback list. Immutable between ingests → edge-
 * caches hard. Empty array on any upstream miss (client keeps its static pool).
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { fetchSuggestions } from '@harpe/sources';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (!(await enforceRateLimit(req, res))) return;

  const suggestions = await fetchSuggestions().catch(() => []);
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({ suggestions });
}
