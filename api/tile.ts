/**
 * /api/tile?url=<tile-image-url>[&referer=<page-url>]
 *
 * Lean, CORS-enabled image passthrough for the deep-zoom canvas stitcher. Unlike
 * /api/fetch it sends NO Content-Disposition (tiles are drawn, not downloaded) and
 * uses its own *generous* rate limit, because stitching one gigapixel image pulls
 * hundreds of tiles in a burst. Tiles are tiny and hard-cached at the edge, so the
 * function rarely sees the same tile twice.
 *
 * Sends `Access-Control-Allow-Origin: *` so the browser can draw the tile onto an
 * exportable (un-tainted) canvas. SSRF-guarded like every other proxy here.
 */

import type { VercelRequest, VercelResponse } from './_vercel.js';
import { fetch } from 'undici';
import type { Response as UndiciResponse } from 'undici';
import { GuardError, guardUrl, pinnedAgent, clientIp } from './_guard.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 16 * 1024 * 1024; // a single tile; generous
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// ── Dedicated burst limiter (tiles are small + edge-cached) ──────────────────
const WINDOW_MS = 60_000;
// A full canvas-cap stitch (16384px long edge / 254px tiles) is ~4k tiles, so the
// per-minute budget must clear one complete stitch. Tiles are tiny + edge-cached.
const MAX_TILES = 6000; // per IP per minute
const buckets = new Map<string, { count: number; start: number }>();
function limitTiles(ip: string): void {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > WINDOW_MS) { buckets.set(ip, { count: 1, start: now }); return; }
  b.count += 1;
  if (b.count > MAX_TILES) throw new GuardError(429, 'Tile rate limit exceeded — slow down');
}

interface NodeWritable {
  write(chunk: Uint8Array): boolean;
  end(cb?: () => void): void;
  once(event: 'drain', cb: () => void): void;
  destroy(err?: Error): void;
}

async function connect(startUrl: string, controller: AbortController, referer?: string) {
  let current = startUrl;
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' };
  if (referer) headers.Referer = referer;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, ip, family } = await guardUrl(current);
    const res = await fetch(url, { dispatcher: pinnedAgent(ip, family), redirect: 'manual', signal: controller.signal, headers });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc || hop === MAX_REDIRECTS) throw new GuardError(502, 'Too many redirects');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new GuardError(502, `Upstream returned ${res.status}`); }
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ct.startsWith('image/')) { await res.body?.cancel(); throw new GuardError(415, 'Not an image'); }
    return { upstream: res as UndiciResponse, contentType: ct };
  }
  throw new GuardError(502, 'Too many redirects');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method !== 'GET') { res.setHeader('Cache-Control', 'no-store'); return res.status(405).json({ error: 'Method not allowed' }); }

  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const rawReferer = typeof req.query.referer === 'string' ? req.query.referer.trim() : undefined;
  if (!raw) { res.setHeader('Cache-Control', 'no-store'); return res.status(400).json({ error: 'Missing ?url=' }); }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    limitTiles(ip);
    await guardUrl(raw);
  } catch (e) {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); }
    throw e;
  }

  let safeReferer: string | undefined;
  if (rawReferer) { try { await guardUrl(rawReferer); safeReferer = rawReferer; } catch { safeReferer = undefined; } }
  // Default the Referer to the tile host's own origin. Many museum IIIF/tile
  // servers (e.g. artic.edu) hotlink-protect: a request with NO Referer gets a
  // 403 HTML page (which the browser then blocks via ORB). A same-origin Referer
  // satisfies the check, so deep-zoom tiles actually load.
  if (!safeReferer) { try { safeReferer = new URL(raw).origin + '/'; } catch { /* ignore */ } }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let conn: { upstream: UndiciResponse; contentType: string };
  try {
    conn = await connect(raw, controller, safeReferer);
  } catch (e) {
    clearTimeout(timer);
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof GuardError) return res.status(e.status).json({ error: e.message });
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'Tile fetch timed out' });
    return res.status(502).json({ error: 'Tile fetch failed' });
  }

  res.setHeader('Content-Type', conn.contentType);
  res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000, max-age=86400');
  res.status(200);
  const out = res as unknown as NodeWritable;
  const reader = conn.upstream.body?.getReader();
  if (!reader) { clearTimeout(timer); out.destroy(); return; }
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel(); out.destroy(new Error('tile too large')); break; }
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
    }
    await new Promise<void>((r) => out.end(r));
  } catch {
    out.destroy();
  } finally {
    clearTimeout(timer);
  }
}
