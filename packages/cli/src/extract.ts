/**
 * Static-HTML image extraction — ported from harpe/extract.py.
 * Pulls candidate image URLs from <img>/<source>/<a>/<link>/<meta>/inline CSS,
 * maps Wikimedia thumbnails to originals, collapses CDN size-variants, and ranks
 * probe results biggest-first. Dimension probing (network) implemented with a
 * hand-rolled PNG/JPEG/GIF/WebP header parser (Range GET, no external deps).
 */
import { parse } from 'node-html-parser';
import { IMG_EXT, MEDIA_EXT } from '@harpe/core';
import { UA, PAGE_MAX, PAGE_MINPX } from './config.js';

const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-hi-res-src', 'data-large', 'data-zoom-image', 'data-image'];
const WM_THUMB = /^(https?:\/\/upload\.wikimedia\.org\/wikipedia\/[^/]+\/)thumb\/(.+?)\/\d+px-[^/]+$/;
const PX = /\/(\d{2,5})px-/;

/** Map a Wikimedia thumbnail URL to its full-resolution original. */
export function wmOriginal(url: string): string {
  const m = WM_THUMB.exec(url);
  return m ? m[1] + m[2] : url;
}

/** Best-effort pixel-width hint from a URL (query param or /NNNpx- segment). */
export function sizeHint(url: string, descriptor = 0): number {
  if (descriptor) return descriptor;
  let qs: URLSearchParams;
  try {
    qs = new URL(url).searchParams;
  } catch {
    qs = new URLSearchParams();
  }
  for (const k of ['w', 'width', 'sz', 'size', 'mw']) {
    const v = qs.get(k);
    if (v) {
      const digits = v.replace(/\D/g, '');
      if (digits) return Number.parseInt(digits, 10);
    }
  }
  const m = PX.exec(url);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function addSrcset(value: string | undefined, add: (u: string, d?: number) => void): void {
  if (!value) return;
  for (const part of value.split(',')) {
    const toks = part.trim().split(/\s+/);
    if (!toks[0]) continue;
    let desc = 0;
    if (toks.length > 1 && toks[1].endsWith('w')) {
      const n = Number.parseInt(toks[1].slice(0, -1), 10);
      desc = Number.isFinite(n) ? n : 0;
    }
    add(toks[0], desc);
  }
}

/** De-duplicated absolute image URLs found in the HTML, largest variant per path. */
export function collect(html: string, base: string): string[] {
  const raw: Array<[string, number]> = [];
  const add = (u?: string | null, descriptor = 0): void => {
    if (!u) return;
    let s = u.trim();
    if (!s || s.startsWith('data:') || s.startsWith('javascript:')) return;
    try {
      const abs = new URL(s, base);
      abs.hash = '';
      s = abs.href;
    } catch {
      return;
    }
    if (s.startsWith('http')) raw.push([s, descriptor]);
  };

  const root = parse(html);
  for (const img of root.querySelectorAll('img')) {
    add(img.getAttribute('src'));
    addSrcset(img.getAttribute('srcset'), add);
    addSrcset(img.getAttribute('data-srcset'), add);
    for (const attr of LAZY_ATTRS) add(img.getAttribute(attr));
  }
  for (const src of root.querySelectorAll('source')) addSrcset(src.getAttribute('srcset'), add);
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    let path = '';
    try { path = new URL(href, base).pathname.toLowerCase(); } catch { path = ''; }
    if (IMG_EXT.some((e) => path.endsWith(e))) add(href);
  }
  for (const ln of root.querySelectorAll('link[rel="preload"]')) {
    if (ln.getAttribute('as') === 'image') add(ln.getAttribute('href'));
  }
  for (const m of root.querySelectorAll('meta')) {
    const prop = m.getAttribute('property');
    if (prop === 'og:image' || prop === 'og:image:url' || m.getAttribute('name') === 'twitter:image') {
      add(m.getAttribute('content'));
    }
  }
  for (const el of root.querySelectorAll('[style]')) {
    const style = el.getAttribute('style') || '';
    for (const mm of style.matchAll(/url\((['"]?)(.*?)\1\)/g)) add(mm[2]);
  }

  // Normalise Wikimedia thumbs to originals, then keep one URL per (host, path),
  // preferring the largest known size variant. Originals always win over thumbs.
  const best = new Map<string, [string, number]>();
  for (const [u, desc] of raw) {
    const u2 = wmOriginal(u);
    const hint = u2 !== u ? 1e7 : sizeHint(u, desc);
    let key: string;
    try {
      const s = new URL(u2);
      key = `${s.host}|${s.pathname}`;
    } catch {
      key = u2;
    }
    const cur = best.get(key);
    if (!cur || hint > cur[1]) best.set(key, [u2, hint]);
  }
  return [...best.values()].map((v) => v[0]);
}

export type Verdict = 'ok' | 'image' | 'retry' | 'drop';
export type Probed = { url: string; verdict: Verdict; size?: [number, number] };

/**
 * Rank probe results into (dim, url) rows, biggest first. Drops confirmed
 * non-images; keeps unknown-size images last. The `minpx` floor removes chrome
 * icons but is relaxed if it would empty the list (never hide all real images).
 */
export function select(probed: Probed[], minpx: number): Array<{ dim: string; url: string }> {
  const ok: Array<{ area: number; dim: string; url: string; edge: number }> = [];
  const unknown: Array<{ area: number; dim: string; url: string }> = [];
  for (const { url, verdict, size } of probed) {
    if (verdict === 'drop') continue;
    if (verdict === 'ok' && size) {
      const [w, h] = size;
      ok.push({ area: w * h, dim: `${w}x${h}`, url, edge: Math.max(w, h) });
    } else {
      unknown.push({ area: -1, dim: '?', url });
    }
  }
  const big = ok.filter((r) => r.edge >= minpx);
  const use = big.length ? big : ok;
  const rows = [...use.map((r) => ({ area: r.area, dim: r.dim, url: r.url })), ...unknown];
  rows.sort((a, b) => b.area - a.area);
  return rows.map((r) => ({ dim: r.dim, url: r.url }));
}

// ─── Hand-rolled image dimension parser ──────────────────────────────────────
// Parses leading bytes of PNG, JPEG, GIF, WebP without any external library.
// Called by probe() with the first ≤128 KB of a response body.

/**
 * Parse image dimensions from leading bytes. Returns [w, h] or null if the
 * header is incomplete or unrecognised. Supports PNG, JPEG, GIF89a/87a, WebP.
 */
export function parseDimensions(buf: Uint8Array): [number, number] | null {
  const len = buf.length;

  // PNG: 8-byte signature + IHDR chunk (width@16, height@20, 4 bytes BE each)
  if (len >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    const w = (buf[16] << 24 | buf[17] << 16 | buf[18] << 8 | buf[19]) >>> 0;
    const h = (buf[20] << 24 | buf[21] << 16 | buf[22] << 8 | buf[23]) >>> 0;
    return w > 0 && h > 0 ? [w, h] : null;
  }

  // GIF: 6-byte header (GIF87a/GIF89a) + width@6, height@8, 2 bytes LE each
  if (len >= 10
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46  // GIF
    && buf[3] === 0x38                                          // 8
    && (buf[4] === 0x37 || buf[4] === 0x39)                    // 7 or 9
    && buf[5] === 0x61) {                                       // a
    const w = buf[6] | buf[7] << 8;
    const h = buf[8] | buf[9] << 8;
    return w > 0 && h > 0 ? [w, h] : null;
  }

  // WebP: RIFF....WEBP VP8 (packed 8/10/L)
  if (len >= 30
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46  // RIFF
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) { // WEBP
    // VP8 (lossy): chunk "VP8 " at offset 12, width/height at 26-27 / 28-29 (14-bit LE, mask 0x3FFF)
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20 && len >= 30) {
      const w = (buf[26] | buf[27] << 8) & 0x3fff;
      const h = (buf[28] | buf[29] << 8) & 0x3fff;
      return w > 0 && h > 0 ? [w, h] : null;
    }
    // VP8L (lossless): chunk "VP8L" at 12, signature 0x2f at 20, then 28-bit packed dims at 21
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c && len >= 25 && buf[20] === 0x2f) {
      const bits = buf[21] | buf[22] << 8 | buf[23] << 16 | buf[24] << 24;
      const w = (bits & 0x3fff) + 1;
      const h = ((bits >>> 14) & 0x3fff) + 1;
      return w > 0 && h > 0 ? [w, h] : null;
    }
    // VP8X (extended): chunk "VP8X" at 12, canvas width@24 (24-bit LE + 1), height@27
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58 && len >= 30) {
      const w = (buf[24] | buf[25] << 8 | buf[26] << 16) + 1;
      const h = (buf[27] | buf[28] << 8 | buf[29] << 16) + 1;
      return w > 0 && h > 0 ? [w, h] : null;
    }
    return null;
  }

  // JPEG: scan for SOF markers (0xFFC0–0xFFC3, 0xFFC5–0xFFC7, 0xFFC9–0xFFCB, 0xFFCD–0xFFCF)
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 3 < len) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      // SOF markers that contain image dimensions
      const isSOF = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF && i + 8 < len) {
        const h = buf[i + 5] << 8 | buf[i + 6];
        const w = buf[i + 7] << 8 | buf[i + 8];
        return w > 0 && h > 0 ? [w, h] : null;
      }
      // Skip over non-SOF segment: length at i+2 (big-endian, includes itself)
      if (i + 3 >= len) break;
      const segLen = buf[i + 2] << 8 | buf[i + 3];
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return null;
  }

  return null;
}

// ─── Network probe ─────────────────────────────────────────────────────────

/**
 * Decode URL basename, sanitise to [\w.\- ]+, cap at 80 chars, append .jpg
 * if the name has no recognised media extension.
 */
export function displayName(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  let n = (decodeURIComponent(path.split('/').pop() || '') || 'image')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 80);
  if (!MEDIA_EXT.some((e) => n.toLowerCase().endsWith(e))) n += '.jpg';
  return n;
}

/**
 * Probe a single URL's dimensions using a Range GET (bytes=0-131071).
 * Parses image header bytes with the hand-rolled parser above.
 *
 * Returns a Probed result:
 *   verdict='ok'    — dimensions resolved (size is [w, h])
 *   verdict='image' — confirmed image/* but dimensions not in the header window
 *   verdict='drop'  — SVG or non-image content-type (HTML, etc.) → discard
 *   verdict='retry' — error / 429 after one retry → keep as unknown
 */
export async function probe(url: string): Promise<Probed> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Range': 'bytes=0-131071',
        },
        redirect: 'follow',
      });

      if (res.status === 429 && attempt === 0) {
        await new Promise<void>((r) => setTimeout(r, 400));
        continue;
      }

      if (res.status >= 400) {
        return { url, verdict: 'retry' };
      }

      const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct === 'image/svg+xml') {
        if (res.body) await res.body.cancel().catch(() => undefined);
        return { url, verdict: 'drop' };
      }
      if (ct && !ct.startsWith('image/')) {
        if (res.body) await res.body.cancel().catch(() => undefined);
        return { url, verdict: 'drop' };
      }

      // Read up to 128 KB then parse
      const chunks: Uint8Array[] = [];
      let totalRead = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (totalRead < 131072) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            chunks.push(value);
            totalRead += value.length;
            // Check if we can already parse (avoid reading everything for large files)
            if (totalRead >= 30) {
              const partial = mergeChunks(chunks, totalRead);
              const dims = parseDimensions(partial);
              if (dims) {
                await reader.cancel();
                return { url, verdict: 'ok', size: dims };
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      if (chunks.length > 0) {
        const buf = mergeChunks(chunks, totalRead);
        const dims = parseDimensions(buf);
        if (dims) return { url, verdict: 'ok', size: dims };
      }

      // Confirmed image/* but couldn't extract dims from header window
      return { url, verdict: ct.startsWith('image/') ? 'image' : 'retry' };
    } catch {
      if (attempt === 0) continue;
      return { url, verdict: 'retry' };
    }
  }
  return { url, verdict: 'retry' };
}

function mergeChunks(chunks: Uint8Array[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * GET a page, collect candidate image URLs, probe their dimensions with
 * bounded concurrency (~8), filter/rank with select(), return display rows.
 */
export async function pageImages(
  page: string,
): Promise<Array<{ dim: string; url: string; name: string }>> {
  const res = await fetch(page, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    redirect: 'follow',
  });
  const base = res.url || page;
  const html = await res.text();

  const urls = collect(html, base).slice(0, PAGE_MAX);
  if (urls.length === 0) return [];

  // Probe with concurrency limit of 8
  const CONCURRENCY = 8;
  const probed: Probed[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((u) => probe(u)));
    probed.push(...results);
  }

  const selected = select(probed, PAGE_MINPX);
  return selected.map(({ dim, url }) => ({ dim, url, name: displayName(url) }));
}
