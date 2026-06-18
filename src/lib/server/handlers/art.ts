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
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { rankResults, qualityScore, type ArtItem } from '@harpe/core';
import { SOURCES, activeSources, gatherSources, mapPool } from '@harpe/sources';

// Re-export the symbols that art-sources.test.ts and art-stream.ts import
// directly from this module — keeps those files unchanged during the refactor.
export { SOURCES, activeSources, gatherSources, mapPool };

const MAX_ITEMS = 40;

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

  // Fetch all sources concurrently; one failing only adds a warning
  const sources = await gatherSources(q);
  const settled = await Promise.allSettled(sources.map(([, p]) => p));

  const items: ArtItem[] = [];
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    const name = sources[i][0];
    if (r.status === 'fulfilled') items.push(...r.value);
    else warnings.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });

  if (items.length === 0 && warnings.length === sources.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'All museum sources failed', warnings });
  }

  // De-dup, gate out non-matching fallback hits, and rank with Reciprocal Rank
  // Fusion — one shared pipeline (src/lib/search.ts) used identically by the
  // client. Fixes "Rodin Thinker" → other Rodin works, and "JW Waterhouse" →
  // unrelated AIC/MoMA fallbacks leaking in.
  const capped = rankResults(items, q, { qualityOf: (it) => qualityScore(it, q) }).slice(0, MAX_ITEMS);

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    items: capped, warnings,
    analyzeEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY),
  });
}
