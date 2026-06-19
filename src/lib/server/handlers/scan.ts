/**
 * /api/scan?url=<page-url>
 *
 * Fetches the page server-side (bypassing browser CORS), extracts image
 * candidate URLs using the same algorithm as harpe/extract.py, and returns:
 *   { images: [{ url, name, width? }] }
 *
 * Security:
 *   - SSRF guard via guard.ts (private IP / bad scheme / bad port rejection)
 *   - Redirect following with per-hop SSRF re-validation (max 3 hops)
 *   - Only text/html responses are accepted
 *   - Body capped at ~4 MB
 *   - 8 second total fetch timeout
 *   - Rate limiting: 30 req/min/IP (in-memory, best-effort; see guard.ts)
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch } from 'undici';
import { parse as parseHtml } from 'node-html-parser';
import { guardUrl, pinnedAgent, GuardError, enforceRateLimit } from '../guard.js';
import { detectFromHtml, type DeepZoomDescriptor } from '../deepzoom-detect.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BODY = 4 * 1024 * 1024; // 4 MB
const TIMEOUT_MS = 8_000;
const FIRECRAWL_TIMEOUT_MS = 22_000; // JS rendering is slower than a static GET
const MAX_CANDIDATES = 150;
const MAX_REDIRECTS = 3;

const IMG_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif',
  '.tiff', '.tif', '.bmp', '.svg',
]);

const LAZY_ATTRS = [
  'data-src', 'data-lazy-src', 'data-original',
  'data-hi-res-src', 'data-large', 'data-zoom-image',
  'data-image', 'data-srcset',
];

// Wikimedia thumbnail pattern: …/thumb/X/Y/N.jpg/123px-N.jpg → …/X/Y/N.jpg
const WM_THUMB = /^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/)thumb\/(.+?)\/\d+px-[^/]+$/;

// Width from URL like /330px- or ?w=400
const PX_RE = /\/(\d{2,5})px-/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function wmOriginal(url: string): string {
  const m = WM_THUMB.exec(url);
  return m ? m[1] + m[2] : url;
}

export function sizeHint(url: string, descriptor = 0): number {
  if (descriptor) return descriptor;
  try {
    const qs = new URL(url).searchParams;
    for (const k of ['w', 'width', 'sz', 'size', 'mw']) {
      const v = qs.get(k);
      if (v) {
        const n = parseInt(v.replace(/\D/g, ''), 10);
        if (n > 0) return n;
      }
    }
  } catch { /* ignore */ }
  const m = PX_RE.exec(url);
  return m ? parseInt(m[1], 10) : 0;
}

export function resolveUrl(href: string, base: string): string | null {
  if (!href || href.startsWith('data:') || href.startsWith('javascript:')) return null;
  try {
    const resolved = new URL(href.trim(), base);
    // Strip fragment
    resolved.hash = '';
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function addSrcset(
  value: string | undefined,
  base: string,
  add: (u: string, d: number) => void,
): void {
  if (!value) return;
  for (const part of value.split(',')) {
    const toks = part.trim().split(/\s+/);
    if (!toks.length || !toks[0]) continue;
    let desc = 0;
    if (toks.length > 1 && toks[1].endsWith('w')) {
      desc = parseInt(toks[1], 10) || 0;
    }
    const url = resolveUrl(toks[0], base);
    if (url) add(url, desc);
  }
}

function extractImages(html: string, base: string): Array<{ url: string; name: string; width?: number }> {
  const raw: Array<[string, number]> = [];

  function add(href: string | undefined, descriptor = 0): void {
    if (!href) return;
    const url = resolveUrl(href, base);
    if (url) raw.push([url, descriptor]);
  }

  const root = parseHtml(html);

  // <img src srcset lazy-attrs>
  for (const img of root.querySelectorAll('img')) {
    add(img.getAttribute('src'));
    addSrcset(img.getAttribute('srcset'), base, add);
    for (const attr of LAZY_ATTRS) {
      add(img.getAttribute(attr));
    }
  }

  // <picture><source srcset>
  for (const src of root.querySelectorAll('source')) {
    addSrcset(src.getAttribute('srcset'), base, add);
  }

  // <a href="...image.ext">
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    try {
      const path = new URL(href, base).pathname.toLowerCase();
      if (IMG_EXT.has(path.slice(path.lastIndexOf('.')))) {
        add(href);
      }
    } catch { /* ignore */ }
  }

  // <link rel="preload" as="image">
  for (const ln of root.querySelectorAll('link')) {
    if (ln.getAttribute('rel') === 'preload' && ln.getAttribute('as') === 'image') {
      add(ln.getAttribute('href'));
    }
  }

  // og:image, twitter:image meta
  for (const meta of root.querySelectorAll('meta')) {
    const prop = meta.getAttribute('property') ?? '';
    const name = meta.getAttribute('name') ?? '';
    if (prop === 'og:image' || prop === 'og:image:url' || name === 'twitter:image') {
      add(meta.getAttribute('content'));
    }
  }

  // Inline CSS background-image: url(...)
  for (const el of root.querySelectorAll('[style]')) {
    const style = el.getAttribute('style') ?? '';
    for (const m of style.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      add(m[2]);
    }
  }

  // Dedupe by (host, path), keep best size hint; Wikimedia thumb → original
  const best = new Map<string, [string, number]>();
  for (const [u, desc] of raw) {
    const u2 = wmOriginal(u);
    const hint = u2 !== u ? 1e7 : sizeHint(u, desc);
    let key: string;
    try {
      const parsed = new URL(u2);
      key = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      key = u2;
    }
    const existing = best.get(key);
    if (!existing || hint > existing[1]) {
      best.set(key, [u2, hint]);
    }
  }

  const results: Array<{ url: string; name: string; width?: number }> = [];
  for (const [url, hint] of best.values()) {
    let name = 'image';
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      const base2 = path.split('/').pop() ?? 'image';
      name = base2.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'image';
      if (!IMG_EXT.has(name.slice(name.lastIndexOf('.')))) {
        name += '.jpg';
      }
    } catch { /* ignore */ }

    const entry: { url: string; name: string; width?: number } = { url, name };
    if (hint > 0 && hint < 1e7) entry.width = hint;
    results.push(entry);
  }

  return results.slice(0, MAX_CANDIDATES);
}

// ─── Fetch with redirect guard ────────────────────────────────────────────────

async function safeFetch(startUrl: string): Promise<{ finalUrl: string; html: string }> {
  let currentUrl = startUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-validate on each hop (prevents open-redirect SSRF) and pin the
      // connection to the validated IP (closes DNS-rebinding TOCTOU).
      const { url, ip, family } = await guardUrl(currentUrl);

      const res = await fetch(url, {
        dispatcher: pinnedAgent(ip, family),
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en',
        },
      });

      // Follow redirects manually so we can guard each hop
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new GuardError(502, 'Redirect with no Location header');
        if (hop === MAX_REDIRECTS) throw new GuardError(502, 'Too many redirects');
        // Resolve relative redirect against current URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new GuardError(502, `Upstream returned ${res.status}`);
      }

      const ct = res.headers.get('content-type') ?? '';
      if (!ct.startsWith('text/html')) {
        throw new GuardError(415, 'URL did not return HTML — only HTML pages are supported');
      }

      // Stream body with size cap
      const reader = res.body?.getReader();
      if (!reader) throw new GuardError(502, 'Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) {
          reader.cancel();
          throw new GuardError(413, 'Page body exceeds 4 MB limit');
        }
        chunks.push(value);
      }

      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const html = new TextDecoder('utf-8', { fatal: false }).decode(combined);
      return { finalUrl: res.url || currentUrl, html };
    }
    throw new GuardError(502, 'Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// ─── Firecrawl fallback (JS-rendered pages) ────────────────────────────────────
// The static fetch above only sees server-rendered HTML. For JS-built galleries
// (infinite scroll, client-side hydration) it finds nothing. When FIRECRAWL_API_KEY
// is set we fall back to Firecrawl, which renders the page and returns final HTML.
// Used ONLY when the static scan found 0 images, to conserve Firecrawl credits.
async function firecrawlScrape(targetUrl: string): Promise<{ finalUrl: string; html: string } | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: targetUrl, formats: ['html'], onlyMainContent: false }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { html?: string; metadata?: { url?: string; sourceURL?: string } } };
    const html = json.data?.html;
    if (!html) return null;
    const finalUrl = json.data?.metadata?.sourceURL || json.data?.metadata?.url || targetUrl;
    return { finalUrl, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — allow the same Vercel deployment to call this from the browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Rate limit
  if (!(await enforceRateLimit(req, res))) return;

  // Validate URL before anything else
  try {
    await guardUrl(rawUrl);
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }

  try {
    const { finalUrl, html } = await safeFetch(rawUrl);
    let images = extractImages(html, finalUrl);
    let rendered = false;
    let scannedHtml = html;
    let scannedUrl = finalUrl;
    // JS-rendered page → nothing in static HTML → try Firecrawl (if configured).
    if (images.length === 0) {
      const fc = await firecrawlScrape(rawUrl);
      if (fc) {
        scannedHtml = fc.html; scannedUrl = fc.finalUrl;
        const fcImages = extractImages(fc.html, fc.finalUrl);
        if (fcImages.length > 0) { images = fcImages; rendered = true; }
      }
    }
    // Detect a zoomable-image descriptor (IIIF / DZI / Zoomify) in the same HTML —
    // cheap when none is present (regex only; no fetch). Lets the client offer our
    // own in-browser deep-zoom + full-res stitch for gigapixel viewers.
    let deepzoom: DeepZoomDescriptor | null = null;
    try { deepzoom = await detectFromHtml(scannedHtml, scannedUrl); } catch { deepzoom = null; }
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json({ images, rendered, deepzoom, sauceEnabled: Boolean(process.env.SAUCENAO_API_KEY) });
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    // AbortError from timeout
    if (e instanceof Error && e.name === 'AbortError') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Page fetch timed out (8s)' });
    }
    console.error('[scan] unexpected error', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Failed to fetch page' });
  }
}

