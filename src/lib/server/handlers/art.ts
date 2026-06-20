/**
 * /api/art?q=<query>
 *
 * Server-side museum search proxy. Queries all configured source adapters
 * concurrently (Art Institute of Chicago, Metropolitan Museum of Art, Cleveland
 * Museum of Art, Wikimedia Commons, Wikidata, and many more) and returns a
 * unified, normalised response with every field as a string.
 *
 * The adapters + SOURCES registry now live in @harpe/sources so the CLI and
 * the Vercel handler share one implementation (monorepo-phase1 refactor).
 *
 * Response shape:
 *   {
 *     items: ArtItem[],
 *     warnings: string[]
 *   }
 *
 * Security:
 *   - q is validated as a non-empty string and URL-encoded before use
 *   - URLs are all fixed museum API hosts — no user-supplied URL, no SSRF risk
 *   - Rate limiting: Upstash Redis when configured, in-memory fallback otherwise
 *   - 12 second per-source timeout (results stream in, so slow public APIs like
 *     Library of Congress / Europeana can finish late instead of being aborted)
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { SOURCES, activeSources, gatherSources, mapPool, searchArt } from '@harpe/sources';

// Re-export the symbols that art-sources.test.ts and art-stream.ts import
// directly from this module — keeps those files unchanged during the refactor.
export { SOURCES, activeSources, gatherSources, mapPool };

// ─── Handler ─────────────────────────────────────────────────────────────────

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

  // Rate limit
  if (!(await enforceRateLimit(req, res))) return;

  // Fan out + dedupe + RRF-rank via the shared engine (also used by the MCP server).
  const { items, warnings, sourceCount } = await searchArt(q);

  if (items.length === 0 && warnings.length === sourceCount) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'All museum sources failed', warnings });
  }

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    items, warnings,
    analyzeEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY),
  });
}
