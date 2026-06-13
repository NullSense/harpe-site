/**
 * /api/fetch?url=<image-url>&referer=<page-url>
 *
 * Image download proxy. Streams the image bytes back to the browser with:
 *   Content-Disposition: attachment; filename="..."
 *   Content-Type: <whatever the upstream returned>
 *
 * This bypasses browser CORS restrictions on cross-origin image downloads.
 *
 * Security:
 *   - SSRF guard via _guard.ts (private IP / bad scheme / bad port rejection)
 *   - Redirect following with per-hop SSRF re-validation (max 3 hops)
 *   - REQUIRES response Content-Type to start with "image/"
 *   - Body capped at ~25 MB
 *   - 10 second total fetch timeout
 *   - Rate limiting: shared 30 req/min/IP with scan.ts (in-memory, best-effort)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetch } from 'undici';
import { GuardError, guardUrl, pinnedAgent, rateLimit, clientIp } from './_guard.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// ─── Fetch with redirect guard ────────────────────────────────────────────────

async function safeFetchImage(
  startUrl: string,
  referer?: string,
): Promise<{ data: Uint8Array; contentType: string }> {
  let currentUrl = startUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'image/*,*/*;q=0.8',
  };
  if (referer) {
    headers['Referer'] = referer;
  }

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-validate on each hop (prevents open-redirect SSRF) and pin the
      // connection to the validated IP (closes DNS-rebinding TOCTOU).
      const { url, ip, family } = await guardUrl(currentUrl);

      const res = await fetch(url, {
        dispatcher: pinnedAgent(ip, family),
        redirect: 'manual',
        signal: controller.signal,
        headers,
      });

      // Follow redirects manually so we can guard each hop
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new GuardError(502, 'Redirect with no Location header');
        if (hop === MAX_REDIRECTS) throw new GuardError(502, 'Too many redirects');
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        throw new GuardError(502, `Upstream returned ${res.status}`);
      }

      const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ct.startsWith('image/')) {
        throw new GuardError(415, 'URL did not return an image — only image/* responses are proxied');
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
        if (total > MAX_BYTES) {
          reader.cancel();
          throw new GuardError(413, 'Image exceeds 25 MB limit');
        }
        chunks.push(value);
      }

      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return { data: combined, contentType: ct };
    }
    throw new GuardError(502, 'Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// ─── Filename derivation ──────────────────────────────────────────────────────

function deriveFilename(url: string, contentType: string): string {
  const IMG_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif',
    '.tiff', '.tif', '.bmp', '.svg',
  ]);
  const CT_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/tiff': '.tiff',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
  };

  let name = 'image';
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const base = path.split('/').pop() ?? '';
    if (base) {
      name = base.replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    }
  } catch { /* ignore */ }

  const lcName = name.toLowerCase();
  const hasExt = IMG_EXT.has(lcName.slice(lcName.lastIndexOf('.')));
  if (!hasExt) {
    name += CT_EXT[contentType] ?? '.jpg';
  }

  return name || 'image.jpg';
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const rawReferer = typeof req.query.referer === 'string' ? req.query.referer.trim() : undefined;

  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Rate limit (Upstash Redis when configured, in-memory fallback otherwise)
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

  // Validate image URL
  try {
    await guardUrl(rawUrl);
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }

  // Validate referer if provided (it's used in a request header, not fetched)
  let safeReferer: string | undefined;
  if (rawReferer) {
    try {
      await guardUrl(rawReferer);
      safeReferer = rawReferer;
    } catch {
      // If referer is invalid, just omit it — don't block the download
      safeReferer = undefined;
    }
  }

  try {
    const { data, contentType } = await safeFetchImage(rawUrl, safeReferer);
    const filename = deriveFilename(rawUrl, contentType);

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '_')}"`,
    );
    res.setHeader('Content-Length', data.byteLength);
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).send(Buffer.from(data));
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    if (e instanceof Error && e.name === 'AbortError') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Image fetch timed out (10s)' });
    }
    console.error('[fetch] unexpected error', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Failed to fetch image' });
  }
}
