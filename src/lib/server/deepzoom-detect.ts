/**
 * Server-side detection + parsing for zoomable-image descriptors (IIIF / DZI /
 * Zoomify). Shared by /api/deepzoom (dedicated endpoint) and /api/scan (which
 * already has the page HTML in hand, so it reports a descriptor for free).
 *
 * The returned DeepZoomDescriptor mirrors src/lib/deepzoom.ts exactly — keep the
 * two shapes in sync (separate client/server builds, like ranking.ts).
 *
 * All outbound fetches go through the SSRF guard (guardUrl + pinnedAgent), same as
 * scan.ts / fetch.ts.
 */

import { fetch } from 'undici';
import { GuardError, guardUrl, pinnedAgent } from './guard.js';

export type DeepZoomProtocol = 'iiif' | 'dzi' | 'zoomify';

export interface DeepZoomDescriptor {
  protocol: DeepZoomProtocol;
  width: number;
  height: number;
  tileSize: number;
  overlap: number;
  format: string;
  base: string;
  title?: string;
  referer?: string;
  sourceUrl?: string;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_DESC_BYTES = 512 * 1024; // descriptors are tiny; cap hard
const MAX_REDIRECTS = 3;

/** Google Arts & Culture: proprietary signed tiles — not stitchable in-browser. */
export function isGoogleArtsAndCulture(url: string): boolean {
  try {
    return /(^|\.)artsandculture\.google\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function descriptorKind(url: string): DeepZoomProtocol | null {
  const u = url.split(/[?#]/)[0].toLowerCase();
  if (u.endsWith('/info.json') || u.endsWith('info.json')) return 'iiif';
  if (u.endsWith('.dzi')) return 'dzi';
  if (u.endsWith('imageproperties.xml')) return 'zoomify';
  return null;
}

function abs(href: string, base: string): string | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Scan page HTML for descriptor URLs. Returns candidates best-first (the first
 * that parses wins). Handles absolute URLs, quoted relative paths, and the common
 * OpenSeadragon `tileSources` embedding.
 */
export function findDescriptorUrls(html: string, base: string): Array<{ url: string; protocol: DeepZoomProtocol }> {
  const out: Array<{ url: string; protocol: DeepZoomProtocol }> = [];
  const seen = new Set<string>();
  const push = (raw: string | null, protocol: DeepZoomProtocol) => {
    if (!raw) return;
    const u = abs(raw, base);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, protocol });
  };

  // Quoted paths (relative or absolute) ending in a known descriptor file.
  for (const m of html.matchAll(/["']([^"'<>\s]+?\/info\.json)(?:[?#][^"'<>\s]*)?["']/gi)) push(m[1], 'iiif');
  for (const m of html.matchAll(/["']([^"'<>\s]+?\.dzi)(?:[?#][^"'<>\s]*)?["']/gi)) push(m[1], 'dzi');
  for (const m of html.matchAll(/["']([^"'<>\s]+?ImageProperties\.xml)(?:[?#][^"'<>\s]*)?["']/gi)) push(m[1], 'zoomify');

  // Bare absolute URLs (e.g. inside JSON blobs / data-attributes without quotes).
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+?\/info\.json/gi)) push(m[0], 'iiif');
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+?\.dzi\b/gi)) push(m[0], 'dzi');
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+?ImageProperties\.xml/gi)) push(m[0], 'zoomify');

  return out;
}

async function fetchText(url: string, accept: string, timeoutMs: number): Promise<{ finalUrl: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { url: safe, ip, family } = await guardUrl(current);
      const res = await fetch(safe, {
        dispatcher: pinnedAgent(ip, family),
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel();
        if (!loc || hop === MAX_REDIRECTS) throw new GuardError(502, 'Too many redirects');
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GuardError(502, `Upstream returned ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new GuardError(502, 'Empty response body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DESC_BYTES) {
          await reader.cancel();
          throw new GuardError(413, 'Descriptor exceeds size limit');
        }
        chunks.push(value);
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return { finalUrl: res.url || current, text: new TextDecoder('utf-8', { fatal: false }).decode(buf) };
    }
    throw new GuardError(502, 'Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

const attr = (xml: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(xml);
  return m ? m[1] : null;
};
const numAttr = (xml: string, name: string): number => {
  const v = attr(xml, name);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function parseIIIF(json: unknown, descUrl: string): DeepZoomDescriptor | null {
  const info = json as Record<string, unknown>;
  const width = Number(info.width);
  const height = Number(info.height);
  if (!width || !height) return null;
  const id = (typeof info['@id'] === 'string' && info['@id']) ||
    (typeof info.id === 'string' && info.id) ||
    descUrl.replace(/\/info\.json.*$/i, '');
  const tiles = Array.isArray(info.tiles) ? (info.tiles[0] as Record<string, unknown> | undefined) : undefined;
  const tileSize = Number(tiles?.width) || 512;
  const label = info.label;
  const title =
    typeof label === 'string'
      ? label
      : (label as Record<string, string[]> | undefined)?.en?.[0] ??
        (label as Record<string, string[]> | undefined)?.none?.[0];
  return {
    protocol: 'iiif',
    width,
    height,
    tileSize,
    overlap: 0,
    format: 'jpg',
    base: String(id).replace(/\/$/, ''),
    title: typeof title === 'string' ? title : undefined,
    sourceUrl: descUrl,
  };
}

function parseDZI(xml: string, descUrl: string): DeepZoomDescriptor | null {
  const width = numAttr(xml, 'Width');
  const height = numAttr(xml, 'Height');
  const tileSize = numAttr(xml, 'TileSize');
  if (!width || !height || !tileSize) return null;
  const format = (attr(xml, 'Format') || 'jpg').toLowerCase();
  const overlap = numAttr(xml, 'Overlap');
  return {
    protocol: 'dzi',
    width,
    height,
    tileSize,
    overlap: Number.isFinite(overlap) ? overlap : 0,
    format,
    base: descUrl.replace(/\.dzi(?:[?#].*)?$/i, ''),
    sourceUrl: descUrl,
  };
}

function parseZoomify(xml: string, descUrl: string): DeepZoomDescriptor | null {
  const width = numAttr(xml, 'WIDTH');
  const height = numAttr(xml, 'HEIGHT');
  const tileSize = numAttr(xml, 'TILESIZE') || 256;
  if (!width || !height) return null;
  return {
    protocol: 'zoomify',
    width,
    height,
    tileSize,
    overlap: 0,
    format: 'jpg',
    base: descUrl.replace(/\/ImageProperties\.xml(?:[?#].*)?$/i, ''),
    sourceUrl: descUrl,
  };
}

/** Fetch + parse a single descriptor URL into a normalized descriptor. */
export async function parseDescriptor(
  url: string,
  protocol: DeepZoomProtocol,
  timeoutMs = 8000,
): Promise<DeepZoomDescriptor | null> {
  if (protocol === 'iiif') {
    const { finalUrl, text } = await fetchText(url, 'application/json,application/ld+json,*/*', timeoutMs);
    try {
      return parseIIIF(JSON.parse(text), finalUrl);
    } catch {
      return null;
    }
  }
  const { finalUrl, text } = await fetchText(url, 'application/xml,text/xml,*/*', timeoutMs);
  return protocol === 'dzi' ? parseDZI(text, finalUrl) : parseZoomify(text, finalUrl);
}

/**
 * Best-effort: given page HTML already fetched elsewhere, detect and parse the
 * first working descriptor. Swallows errors (returns null) — it's an enhancement,
 * never a hard failure. Used by /api/scan.
 */
export async function detectFromHtml(html: string, baseUrl: string, timeoutMs = 6000): Promise<DeepZoomDescriptor | null> {
  const candidates = findDescriptorUrls(html, baseUrl).slice(0, 5);
  for (const { url, protocol } of candidates) {
    try {
      const d = await parseDescriptor(url, protocol, timeoutMs);
      if (d) { d.referer = baseUrl; return d; }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
