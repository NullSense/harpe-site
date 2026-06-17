/**
 * Static-HTML image extraction — ported from harpe/extract.py (pure parts).
 * Pulls candidate image URLs from <img>/<source>/<a>/<link>/<meta>/inline CSS,
 * maps Wikimedia thumbnails to originals, collapses CDN size-variants, and ranks
 * probe results biggest-first. Dimension probing (network) lives in the runner.
 */
import { parse } from 'node-html-parser';
import { IMG_EXT } from '@harpe/core';

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
