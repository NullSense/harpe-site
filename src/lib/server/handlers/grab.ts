/**
 * /api/grab?url=<media-page-url>
 *
 * Universal media resolver via a SELF-HOSTED cobalt instance (imputnet/cobalt).
 * The site can't download YouTube/IG/TikTok/etc. itself — datacenter IPs are
 * network-blocked and attestation (PO tokens) is required. cobalt run on your
 * homelab's RESIDENTIAL IP sidesteps that; this endpoint relays to it.
 *
 * Config (server-only env):
 *   COBALT_API_URL   base URL of your cobalt instance (e.g. https://cobalt.you.dev)
 *   COBALT_API_KEY   optional Api-Key if your instance requires one
 * Inert (501) until COBALT_API_URL is set, so it ships safely.
 *
 * We POST the user URL to cobalt as a JSON body (we never fetch it ourselves → no
 * SSRF surface here). cobalt returns a direct/tunnel file URL or a picker; we
 * normalise it. cobalt is AGPL-3.0 — we only CALL it over HTTP (no code linkage).
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { fetchWithTimeout } from '../fetchWithTimeout.js';

const TIMEOUT_MS = 25_000;
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

interface Media { type: 'video' | 'audio' | 'photo'; url: string; filename?: string; thumb?: string; }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method !== 'GET') { res.setHeader('Cache-Control', 'no-store'); return res.status(405).json({ error: 'Method not allowed' }); }

  const cobalt = process.env.COBALT_API_URL;
  if (!cobalt) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'Universal video download needs a self-hosted cobalt instance (set COBALT_API_URL) — or use the Harpe CLI.', configured: false });
  }

  const url = s(req.query.url).trim();
  if (!/^https?:\/\//i.test(url)) { res.setHeader('Cache-Control', 'no-store'); return res.status(400).json({ error: 'Provide an http(s) URL' }); }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try { await rateLimit(ip); }
  catch (e) { if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); } throw e; }

  try {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (process.env.COBALT_API_KEY) headers.Authorization = `Api-Key ${process.env.COBALT_API_KEY}`;
    const r = await fetchWithTimeout(cobalt.replace(/\/$/, '') + '/', {
      timeoutMs: TIMEOUT_MS,
      method: 'POST', headers,
      body: JSON.stringify({ url, videoQuality: '1080', filenameStyle: 'basic', downloadMode: 'auto' }),
    });
    const j = await r.json() as {
      status?: string; url?: unknown; filename?: unknown;
      picker?: Array<{ type?: string; url?: unknown; thumb?: unknown }>;
      error?: { code?: unknown };
    };

    const media: Media[] = [];
    switch (j.status) {
      case 'redirect':
      case 'tunnel':
        if (s(j.url)) media.push({ type: 'video', url: s(j.url), filename: s(j.filename) || undefined });
        break;
      case 'picker':
        for (const p of (j.picker ?? [])) {
          if (s(p.url)) media.push({ type: (p.type === 'photo' ? 'photo' : p.type === 'audio' ? 'audio' : 'video'), url: s(p.url), thumb: s(p.thumb) || undefined });
        }
        break;
      case 'local-processing':
        // cobalt wants the client to merge separate streams (mainly YouTube). Not
        // supported via the site yet — honest hand-off.
        res.setHeader('Cache-Control', 'no-store');
        return res.status(422).json({ error: 'This source needs client-side merging — use the Harpe extension or CLI.', status: j.status });
      case 'error':
      default:
        res.setHeader('Cache-Control', 'no-store');
        return res.status(502).json({ error: `cobalt: ${s(j.error?.code) || j.status || 'unknown error'}` });
    }
    if (media.length === 0) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'No downloadable media found' }); }

    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ ok: true, media });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'cobalt timed out' });
    return res.status(502).json({ error: 'cobalt request failed' });
  }
}
