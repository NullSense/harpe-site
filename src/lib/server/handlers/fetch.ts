/**
 * /api/fetch?url=<image-url>&referer=<page-url>[&w=<px>&h=<px>&fmt=jpeg|png|webp|avif&q=<1-100>]
 *
 * Image download proxy. Streams the image bytes back to the browser with:
 *   Content-Disposition: attachment; filename="..."
 *   Content-Type: <whatever the upstream returned>
 *
 * This bypasses browser CORS restrictions on cross-origin image downloads.
 *
 * Optional conversion params (any present triggers sharp processing):
 *   w   — max output width in px (positive integer ≤ 8000, else ignored)
 *   h   — max output height in px (positive integer ≤ 8000, else ignored)
 *   fmt — output format: jpeg | png | webp | avif (else ignored)
 *   q   — quality 1–100 (clamped; default 82)
 * When none of w/h/fmt/q are present: original streaming passthrough (no change).
 *
 * Security:
 *   - SSRF guard via guard.ts (private IP / bad scheme / bad port rejection)
 *   - Redirect following with per-hop SSRF re-validation (max 3 hops)
 *   - REQUIRES response Content-Type to start with "image/"
 *   - Body buffered (conversion) or streamed (passthrough) with an 80 MB DoS cap
 *   - 20 second total fetch timeout
 *   - Rate limiting: shared 30 req/min/IP with scan.ts (in-memory, best-effort)
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch } from 'undici';
import type { Response as UndiciResponse } from 'undici';
import { guardUrl, pinnedAgent, GuardError, enforceRateLimit } from '../guard.js';
import sharp from 'sharp';

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 80 * 1024 * 1024; // 80 MB — fits lossless TIFF originals
const TIMEOUT_MS = 20_000;
// Wikimedia Commons `http://…/Special:FilePath/…` is a 4-hop chain
// (http→https upgrade, then FilePath→thumb→upload), so 3 was too low and
// produced spurious 502s. Each hop is independently SSRF-re-guarded below, so a
// higher cap costs nothing in safety; 6 leaves headroom for thumb redirects.
export const MAX_REDIRECTS = 6;

// The underlying Vercel response IS a Node ServerResponse; our minimal
// VercelResponse type omits the streaming methods, so we narrow to them here.
interface NodeWritable {
  write(chunk: Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(cb?: () => void): void;
  once(event: 'drain', cb: () => void): void;
  destroy(err?: Error): void;
}

// ─── Fetch with redirect guard (returns the un-read upstream response) ─────────

export async function safeFetchImage(
  startUrl: string,
  controller: AbortController,
  referer?: string,
): Promise<{ upstream: UndiciResponse; contentType: string; contentLength?: number }> {
  let currentUrl = startUrl;

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'image/*,video/*,audio/*,*/*;q=0.8',
  };
  if (referer) {
    headers['Referer'] = referer;
  }

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
      await res.body?.cancel();
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new GuardError(502, `Upstream returned ${res.status}`);
    }

    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    // Media proxy: images (sharp-convertible) plus video/audio passthrough (X/Insta
    // clips etc.). sharp conversion only runs when w/h/fmt/q are passed, which the
    // client never does for video — so video is always a clean streaming passthrough.
    if (!/^(image|video|audio)\//.test(ct)) {
      await res.body?.cancel();
      throw new GuardError(415, 'URL did not return image/video/audio — only media is proxied');
    }

    const lenHeader = Number(res.headers.get('content-length'));
    const contentLength = Number.isFinite(lenHeader) && lenHeader > 0 ? lenHeader : undefined;
    if (contentLength && contentLength > MAX_BYTES) {
      await res.body?.cancel();
      throw new GuardError(413, 'Image exceeds 80 MB limit');
    }

    return { upstream: res, contentType: ct, contentLength };
  }
  throw new GuardError(502, 'Too many redirects');
}

// Stream the upstream body to the Node response, enforcing the byte cap as we go
// so a lying/absent Content-Length can't blow past MAX_BYTES.
async function streamToResponse(upstream: UndiciResponse, out: NodeWritable): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new GuardError(502, 'Empty response body');
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      out.destroy(new Error('size cap exceeded'));
      throw new GuardError(413, 'Image exceeds 80 MB limit');
    }
    // Respect backpressure so we never buffer the whole file in memory.
    const ok = out.write(value);
    if (!ok) await new Promise<void>((resolve) => out.once('drain', resolve));
  }
  await new Promise<void>((resolve) => out.end(resolve));
}

// ─── Conversion param parsing ─────────────────────────────────────────────────

const FMT_ALLOWLIST = new Set(['jpeg', 'png', 'webp', 'avif']);
const FMT_CT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

interface ConvertParams {
  w?: number;
  h?: number;
  fmt?: string;
  q?: number;
}

export function parseConvertParams(query: Record<string, string | string[] | undefined>): ConvertParams {
  const p: ConvertParams = {};

  const parseIntParam = (key: string, max: number): number | undefined => {
    const raw = typeof query[key] === 'string' ? (query[key] as string) : '';
    if (!raw) return undefined;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > max) return undefined;
    return n;
  };

  p.w = parseIntParam('w', 8000);
  p.h = parseIntParam('h', 8000);

  const rawFmt = typeof query.fmt === 'string' ? query.fmt.toLowerCase().trim() : '';
  if (rawFmt && FMT_ALLOWLIST.has(rawFmt)) p.fmt = rawFmt;

  const rawQ = typeof query.q === 'string' ? (query.q as string) : '';
  if (rawQ) {
    const qn = Math.round(Number(rawQ));
    if (Number.isFinite(qn)) p.q = Math.max(1, Math.min(100, qn));
  }

  return p;
}

export function needsConversion(p: ConvertParams): boolean {
  return !!(p.w || p.h || p.fmt || p.q);
}

// ─── Buffer the body (for sharp conversion) ───────────────────────────────────

async function bufferBody(upstream: UndiciResponse): Promise<Buffer> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new GuardError(502, 'Empty response body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new GuardError(413, 'Image exceeds 80 MB limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ─── Filename derivation ──────────────────────────────────────────────────────

export function deriveFilename(url: string, contentType: string): string {
  const IMG_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif',
    '.tiff', '.tif', '.bmp', '.svg',
    '.mp4', '.webm', '.mov', '.m4a', '.mp3', '.ogg',
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
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
  };

  // 'image' is the wrong default for a video/audio download.
  const fallbackStem = contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'image';

  let name = fallbackStem;
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
    name += CT_EXT[contentType] ?? (fallbackStem === 'image' ? '.jpg' : `.${fallbackStem === 'video' ? 'mp4' : 'm4a'}`);
  }

  return name || `${fallbackStem}.${fallbackStem === 'image' ? 'jpg' : fallbackStem === 'video' ? 'mp4' : 'm4a'}`;
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
  const convert = parseConvertParams(req.query as Record<string, string | string[] | undefined>);

  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Rate limit (Upstash Redis when configured, in-memory fallback otherwise)
  if (!(await enforceRateLimit(req, res))) return;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // ── Phase 1: connect + validate (errors here can still send a clean JSON body)
  let connected: { upstream: UndiciResponse; contentType: string; contentLength?: number };
  try {
    connected = await safeFetchImage(rawUrl, controller, safeReferer);
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    if (e instanceof Error && e.name === 'AbortError') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Image fetch timed out (20s)' });
    }
    console.error('[fetch] unexpected error', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'Failed to fetch image' });
  }

  // ── Phase 2: commit headers + stream/convert ─────────────────────────────────
  const { upstream, contentType, contentLength } = connected;

  if (needsConversion(convert)) {
    // Buffer the body, run through sharp, send the result.
    let buf: Buffer;
    try {
      buf = await bufferBody(upstream);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof GuardError) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(e.status).json({ error: e.message });
      }
      console.error('[fetch] buffer error', e);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Failed to read image body' });
    }

    let pipeline = sharp(buf).rotate(); // honour EXIF orientation

    if (convert.w || convert.h) {
      pipeline = pipeline.resize({
        width: convert.w,
        height: convert.h,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Determine output format: explicit fmt param, else infer from source content-type
    const outFmt = (convert.fmt ?? contentType.replace('image/', '').replace('jpeg', 'jpeg')) as
      keyof sharp.FormatEnum;
    const safeFmt = FMT_ALLOWLIST.has(outFmt) ? outFmt : 'jpeg';
    const quality = convert.q ?? 82;

    let outBuf: Buffer;
    try {
      if (safeFmt === 'png') {
        outBuf = await pipeline.png({ quality }).toBuffer();
      } else if (safeFmt === 'webp') {
        outBuf = await pipeline.webp({ quality }).toBuffer();
      } else if (safeFmt === 'avif') {
        outBuf = await pipeline.avif({ quality }).toBuffer();
      } else {
        outBuf = await pipeline.jpeg({ quality }).toBuffer();
      }
    } catch (e) {
      clearTimeout(timer);
      console.error('[fetch] sharp error', e);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(422).json({ error: 'Image conversion failed' });
    }

    // Derive filename with the converted extension
    const outContentType = FMT_CT[safeFmt] ?? 'image/jpeg';
    const baseFilename = deriveFilename(rawUrl, contentType);
    const stem = baseFilename.replace(/\.[^.]+$/, '');
    const ext = safeFmt === 'jpeg' ? 'jpg' : safeFmt;
    const outFilename = `${stem}.${ext}`;

    clearTimeout(timer);
    res.setHeader('Content-Type', outContentType);
    res.setHeader('Content-Disposition', `attachment; filename="${outFilename.replace(/"/g, '_')}"`);
    res.setHeader('Content-Length', outBuf.byteLength);
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200);
    (res as unknown as NodeWritable).write(outBuf);
    await new Promise<void>((resolve) => (res as unknown as NodeWritable).end(resolve));
    return;
  }

  // Passthrough: headers committed here — on error we can only destroy the socket.
  const filename = deriveFilename(rawUrl, contentType);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '_')}"`);
  if (contentLength) res.setHeader('Content-Length', contentLength);
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  res.status(200);
  try {
    await streamToResponse(upstream, res as unknown as NodeWritable);
  } catch (e) {
    console.error('[fetch] stream aborted', e);
    (res as unknown as NodeWritable).destroy();
  } finally {
    clearTimeout(timer);
  }
}
