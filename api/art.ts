/**
 * /api/art?q=<query>
 *
 * Server-side museum search proxy. Queries three museum APIs concurrently
 * (Art Institute of Chicago, Metropolitan Museum of Art, Cleveland Museum of Art)
 * and returns a unified, normalised response with every field as a string.
 *
 * This fixes two client-side problems:
 *   1. Cleveland CORS "Failed to fetch" errors (server-side fetch bypasses CORS)
 *   2. Cleveland's `dimensions` field is an OBJECT — we normalise it here so
 *      React never receives an object where it expects a string.
 *
 * Response shape:
 *   {
 *     items: [{
 *       id: string, title: string, artist: string, dimensions: string,
 *       thumbUrl: string, fullUrl: string,
 *       source: "aic"|"met"|"cleveland", isPublicDomain: boolean
 *     }],
 *     warnings: string[]
 *   }
 *
 * Security:
 *   - q is validated as a non-empty string and URL-encoded before use
 *   - URLs are all fixed museum API hosts — no user-supplied URL, no SSRF risk
 *   - Rate limiting: Upstash Redis when configured, in-memory fallback otherwise
 *   - 8 second per-source timeout
 */

import type { VercelRequest, VercelResponse } from './_vercel.js';
import { fetch } from 'undici';
import { GuardError, rateLimit, clientIp } from './_guard.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8_000;
const MAX_ITEMS = 30;

// ─── Response types ───────────────────────────────────────────────────────────

interface ArtItem {
  id: string;
  title: string;
  artist: string;
  dimensions: string;
  thumbUrl: string;
  fullUrl: string;
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart';
  isPublicDomain: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  // Objects / arrays: do NOT pass through — coerce to empty string to prevent
  // React error #31 ("Objects are not valid as a React child").
  return '';
}

// Query-relevance ranking (mirrors the CLI's harpe.rank): score each result by
// how many query tokens appear in its title+artist, so the ACTUAL work searched
// for floats to the top instead of just "other works by the same artist".
const STOP = new Set([
  'the', 'and', 'of', 'to', 'in', 'on', 'by', 'with', 'from', 'for',
  'his', 'her', 'its', 'a', 'an', 'at', 'as',
]);

function queryTokens(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
}

function relevance(item: ArtItem, toks: string[]): number {
  const hay = `${item.title} ${item.artist}`.toLowerCase();
  let r = 0;
  for (const t of toks) if (hay.includes(t)) r++;
  return r;
}

async function timedFetch(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    signal,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }) as unknown as Response;
}

// ─── AIC (Art Institute of Chicago) ──────────────────────────────────────────

async function fetchAic(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url =
      `https://api.artic.edu/api/v1/artworks/search` +
      `?q=${encodeURIComponent(q)}&fields=id,title,artist_title,image_id,is_public_domain,dimensions&limit=12`;

    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown;
        title?: unknown;
        artist_title?: unknown;
        image_id?: unknown;
        is_public_domain?: unknown;
        dimensions?: unknown;
      }>;
      config?: { iiif_url?: unknown };
    };

    const iiif = str(json.config?.iiif_url) || 'https://www.artic.edu/iiif/2';
    const items: ArtItem[] = [];

    for (const d of json.data ?? []) {
      const imageId = str(d.image_id);
      if (!imageId) continue;

      items.push({
        id: `aic-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist: str(d.artist_title),
        dimensions: String(d.dimensions ?? ''),
        thumbUrl: `${iiif}/${imageId}/full/843,/0/default.jpg`,
        fullUrl: `${iiif}/${imageId}/full/full/0/default.jpg`,
        source: 'aic',
        isPublicDomain: Boolean(d.is_public_domain),
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Met (Metropolitan Museum of Art) ────────────────────────────────────────

async function fetchMet(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const searchUrl =
      `https://collectionapi.metmuseum.org/public/collection/v1/search` +
      `?q=${encodeURIComponent(q)}&hasImages=true`;

    const searchRes = await timedFetch(searchUrl, controller.signal);
    if (!searchRes.ok) throw new Error(`HTTP ${searchRes.status}`);

    const searchJson = await searchRes.json() as { objectIDs?: unknown[] };
    const ids = (searchJson.objectIDs ?? []).slice(0, 10).map(Number).filter(Boolean);
    if (ids.length === 0) return [];

    // Fetch each object concurrently, gracefully ignore failures
    const objectResults = await Promise.allSettled(
      ids.map((id) =>
        timedFetch(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
          controller.signal,
        ).then((r) => r.json()),
      ),
    );

    const items: ArtItem[] = [];
    for (const result of objectResults) {
      if (result.status !== 'fulfilled') continue;
      const d = result.value as {
        objectID?: unknown;
        title?: unknown;
        artistDisplayName?: unknown;
        culture?: unknown;
        dimensions?: unknown;
        primaryImage?: unknown;
        primaryImageSmall?: unknown;
        isPublicDomain?: unknown;
      };

      const primaryImage = str(d.primaryImage);
      if (!primaryImage) continue;

      const thumbUrl = str(d.primaryImageSmall) || primaryImage;
      const artist = str(d.artistDisplayName) || str(d.culture);

      items.push({
        id: `met-${str(d.objectID)}`,
        title: str(d.title) || 'Untitled',
        artist,
        dimensions: String(d.dimensions ?? ''),
        thumbUrl,
        fullUrl: primaryImage,
        source: 'met',
        isPublicDomain: Boolean(d.isPublicDomain),
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Cleveland Museum of Art ──────────────────────────────────────────────────

async function fetchCleveland(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // No cc0 filter — that excluded famous casts (e.g. Cleveland's The Thinker).
    // We keep has_image and badge rights per-item from share_license_status.
    const url =
      `https://openaccess-api.clevelandart.org/api/artworks/` +
      `?q=${encodeURIComponent(q)}&has_image=1&limit=12`;

    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown;
        title?: unknown;
        creators?: Array<{ description?: unknown }>;
        share_license_status?: unknown;
        // dimensions is an OBJECT in Cleveland's API — deliberately typed as
        // unknown to force explicit handling below; never pass through raw.
        dimensions?: unknown;
        measurements?: unknown;
        images?: {
          full?: { url?: unknown };
          web?: { url?: unknown };
        };
      }>;
    };

    const items: ArtItem[] = [];
    for (const d of json.data ?? []) {
      const images = d.images ?? {};
      const imageUrl =
        str((images as { full?: { url?: unknown } }).full?.url) ||
        str((images as { web?: { url?: unknown } }).web?.url);
      if (!imageUrl) continue;

      const artist =
        (d.creators?.[0] !== undefined ? str(d.creators[0].description) : '') || '';

      // Cleveland's `dimensions` field is an OBJECT — do NOT use it.
      // Use `measurements` (a string field) when available; otherwise empty string.
      const dimensions = typeof d.measurements === 'string' ? d.measurements : '';

      items.push({
        id: `cleveland-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist,
        dimensions,
        thumbUrl: imageUrl,
        fullUrl: imageUrl,
        source: 'cleveland',
        isPublicDomain: str(d.share_license_status).toUpperCase() === 'CC0',
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wikimedia Commons (huge coverage — the real recall fix) ──────────────────

async function fetchCommons(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url =
      `https://commons.wikimedia.org/w/api.php?action=query&format=json` +
      `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=15` +
      `&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=843`;

    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      query?: {
        pages?: Record<string, {
          title?: unknown;
          imageinfo?: Array<{
            url?: unknown; thumburl?: unknown;
            width?: unknown; height?: unknown; mime?: unknown;
          }>;
        }>;
      };
    };

    const items: ArtItem[] = [];
    for (const p of Object.values(json.query?.pages ?? {})) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      if (!/^image\/(jpeg|png|tiff|webp)/.test(str(ii.mime))) continue;
      const full = str(ii.url);
      if (!full) continue;
      const w = Number(ii.width) || 0;
      const h = Number(ii.height) || 0;
      const title = str(p.title).replace(/^File:/, '').replace(/\.[A-Za-z0-9]+$/, '');
      items.push({
        id: `commons-${title}`,
        title: title || 'Untitled',
        artist: '',
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: str(ii.thumburl) || full,
        fullUrl: full,
        source: 'commons',
        isPublicDomain: true, // Commons hosts freely-licensed / PD media
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── WikiArt (paintings-focused; keyless v2 API) ──────────────────────────────

async function fetchWikiArt(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `https://www.wikiart.org/en/api/2/PaintingSearch?term=${encodeURIComponent(q)}`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: unknown; title?: unknown; artistName?: unknown;
        completitionYear?: unknown; image?: unknown;
        width?: unknown; height?: unknown;
      }>;
    };

    const items: ArtItem[] = [];
    for (const d of json.data ?? []) {
      const image = str(d.image);
      if (!image) continue;
      const year = d.completitionYear ? ` (${str(d.completitionYear)})` : '';
      const w = Number(d.width) || 0;
      const h = Number(d.height) || 0;
      items.push({
        id: `wikiart-${str(d.id)}`,
        title: (str(d.title) || 'Untitled') + year,
        artist: str(d.artistName),
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: image, // the "!Large.jpg" variant
        fullUrl: image.replace(/!.*$/, ''), // strip variant suffix → original
        source: 'wikiart',
        isPublicDomain: false, // WikiArt is mixed-rights; badge a rights caution
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

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
  const sources: Array<[string, Promise<ArtItem[]>]> = [
    ['AIC', fetchAic(q)],
    ['Met', fetchMet(q)],
    ['Cleveland', fetchCleveland(q)],
    ['Commons', fetchCommons(q)],
    ['WikiArt', fetchWikiArt(q)],
  ];
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

  // Rank by query relevance FIRST (so the actual work searched for is on top),
  // then public-domain, then source order. This is the fix for "Rodin Thinker"
  // returning other Rodin works instead of The Thinker.
  const toks = queryTokens(q);
  const SOURCE_ORDER: Record<string, number> = { aic: 0, met: 1, cleveland: 2, wikiart: 3, commons: 4 };
  items.sort((a, b) => {
    const ra = relevance(a, toks);
    const rb = relevance(b, toks);
    if (ra !== rb) return rb - ra;
    if (a.isPublicDomain !== b.isPublicDomain) return a.isPublicDomain ? -1 : 1;
    return (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9);
  });

  // Cap total
  const capped = items.slice(0, MAX_ITEMS);

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({ items: capped, warnings });
}
