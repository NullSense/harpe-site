/**
 * /api/iiif?url=<…/info.json>
 *
 * Same-origin CORS proxy for IIIF Image-API `info.json` documents. Many museum
 * IIIF servers (e.g. artic.edu) don't send Access-Control-Allow-Origin, so the
 * browser can't fetch info.json directly and OpenSeadragon's tiled deep-zoom
 * fails. We fetch it server-side and re-serve it with CORS. The info.json's `@id`
 * still points at the museum's server, so the actual tiles load straight from
 * there as plain <img> requests (no CORS needed for canvas drawing).
 *
 * SSRF-guarded (public http(s) only), rate-limited, and cached hard (info.json is
 * effectively immutable).
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch } from 'undici';
import { GuardError, guardUrl, pinnedAgent, rateLimit, clientIp } from '../guard.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!raw || !/\/info\.json(?:[?#]|$)/i.test(raw)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Provide a IIIF ?url=…/info.json' });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  let guarded: { url: string; ip: string; family: 4 | 6 };
  try {
    await rateLimit(ip);
    guarded = await guardUrl(raw); // reject private/non-http targets; pin the IP
  } catch (e) {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); }
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Dial the pre-validated IP (pinnedAgent) so a DNS-rebind between guard and
    // connect can't reach a private host — matches fetch/scan/tile/deepzoom.
    const r = await fetch(guarded.url, {
      signal: controller.signal,
      dispatcher: pinnedAgent(guarded.ip, guarded.family),
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!r.ok) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: `Upstream ${r.status}` }); }
    const json = await r.json();
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(json);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'IIIF info fetch timed out' });
    return res.status(502).json({ error: 'IIIF info fetch failed' });
  } finally {
    clearTimeout(timer);
  }
}
