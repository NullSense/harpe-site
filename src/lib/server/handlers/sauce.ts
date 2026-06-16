/**
 * /api/sauce?url=<image-url>
 *
 * Reverse-image search via SauceNAO: given an image URL (e.g. one the page
 * scanner found, or pasted by the user), find where else it appears online and
 * what it is — source page, title, artist, and a higher-res original to chase.
 *
 * Returns: { results: [{ similarity, thumbnail, title, author, site, urls[] }] }
 *
 * Dormant until SAUCENAO_API_KEY is set (returns 501). The key is server-only
 * and never reaches the browser. Rate-limited per IP; the image URL is validated
 * (public http(s) only) before we hand it to SauceNAO.
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch } from 'undici';
import { GuardError, guardUrl, rateLimit, clientIp } from '../guard.js';

const TIMEOUT_MS = 12_000;

interface SauceResult {
  similarity: number;
  thumbnail: string;
  title: string;
  author: string;
  site: string;
  urls: string[];
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}
function s(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const key = process.env.SAUCENAO_API_KEY;
  if (!key) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'Reverse-image search is not configured' });
  }

  const imageUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!imageUrl) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    await rateLimit(ip);
    await guardUrl(imageUrl); // reject private/non-http targets before sending it on
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const api =
      `https://saucenao.com/search.php?output_type=2&numres=8&db=999` +
      `&api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(imageUrl)}`;
    const r = await fetch(api, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: `SauceNAO returned ${r.status}` });
    }
    const json = (await r.json()) as {
      header?: { status?: number; message?: string };
      results?: Array<{
        header?: { similarity?: unknown; thumbnail?: unknown; index_name?: unknown };
        data?: { ext_urls?: unknown; title?: unknown; source?: unknown; member_name?: unknown; creator?: unknown; author_name?: unknown };
      }>;
    };
    const status = json.header?.status ?? 0;
    if (status > 0) {
      // Positive status = account/limit problem (e.g. daily quota hit).
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).json({ error: json.header?.message || 'SauceNAO rate/quota limit reached' });
    }

    const results: SauceResult[] = [];
    for (const item of json.results ?? []) {
      const urls = Array.isArray(item.data?.ext_urls)
        ? (item.data!.ext_urls as unknown[]).map(s).filter((u) => /^https?:/i.test(u))
        : [];
      if (urls.length === 0) continue;
      const author = s(item.data?.creator) || s(item.data?.member_name) || s(item.data?.author_name);
      let site = '';
      try { site = new URL(urls[0]).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      results.push({
        similarity: num(item.header?.similarity),
        thumbnail: s(item.header?.thumbnail),
        title: s(item.data?.title) || s(item.header?.index_name),
        author,
        site,
        urls,
      });
    }
    results.sort((a, b) => b.similarity - a.similarity);

    // Cache modestly: same image → same matches for a while.
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ results });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') {
      return res.status(504).json({ error: 'Reverse-image search timed out' });
    }
    console.error('[sauce] error', e);
    return res.status(502).json({ error: 'Reverse-image search failed' });
  } finally {
    clearTimeout(timer);
  }
}
