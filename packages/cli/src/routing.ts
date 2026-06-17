/**
 * URL classification — ported from harpe/routing.py. Decides how a URL is
 * handled: zoomable art, reference/encyclopedia page, video, or images.
 * Network pieces: queryFromUrl (JSON-LD / og:title / <title> extraction),
 * hasVideo (yt-dlp probe).
 */
import { parse } from 'node-html-parser';
import { spawn } from 'node:child_process';
import { UA } from './config.js';

export const VIDEO_EXTS = new Set([
  'mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi', 'ts', '3gp', 'mpg', 'mpeg', 'm2ts',
]);

// Single-artwork / encyclopedia pages: route these to federated museum search by
// derived name (usually finds the same work as a higher-res CC0 original).
const REFERENCE_HOSTS = [
  'wikipedia.org/wiki/', 'wikiart.org/', 'britannica.com/',
  '.metmuseum.org/art/', 'artic.edu/artworks/', 'clevelandart.org/art/',
  'tate.org.uk/art/', 'nationalgallery.org.uk/paintings/',
  'getty.edu/art/collection/object', 'nga.gov/artworks/',
  'moma.org/collection/works/',
];

const BOTWALL = /security checkpoint|just a moment|attention required|access denied|are you a robot/i;
const SITE_TAIL =
  /\s*[|·–—-]\s+[^|·–—-]*(Museum|Gallery|Institute|Collection|Wikipedia|Wikimedia|Culture|Rijksmuseum|Europeana|WikiArt|Metropolitan)[^|·–—-]*$/i;
const PIPE_TAIL = /\s*\|\s*[^|]*$/;

/** A Google Arts & Culture / IIIF / manifest URL → tile-stitched deep zoom. */
export function isArtUrl(url: string): boolean {
  const u = url.toLowerCase();
  return u.includes('artsandculture.google.com') || u.includes('/iiif/') || u.includes('?iiif') || u.includes('manifest.json');
}

/** A single-artwork / encyclopedia page → derive a name and museum-search it. */
export function isReferencePage(url: string): boolean {
  const u = url.toLowerCase();
  return REFERENCE_HOSTS.some((h) => u.includes(h));
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** Strip site/museum suffixes and reject bot-wall titles. Pure (testable). */
export function cleanTitle(t: string): string {
  let s = (t || '').replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m);
  s = s.replace(SITE_TAIL, '');
  s = s.replace(PIPE_TAIL, ''); // `|` is almost always a site separator
  if (BOTWALL.test(s)) return '';
  return s.trim();
}

// ─── JSON-LD helpers ─────────────────────────────────────────────────────────

function* iterObjects(data: unknown): Generator<Record<string, unknown>> {
  if (data !== null && typeof data === 'object') {
    if (Array.isArray(data)) {
      for (const v of data) yield* iterObjects(v);
    } else {
      yield data as Record<string, unknown>;
      for (const v of Object.values(data as Record<string, unknown>)) yield* iterObjects(v);
    }
  }
}

function creatorName(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    for (const x of c) { const n = creatorName(x); if (n) return n; }
  }
  if (c !== null && typeof c === 'object') {
    const n = (c as Record<string, unknown>)['name'];
    return typeof n === 'string' ? n : '';
  }
  return '';
}

/**
 * Extract artwork name (+creator) from schema.org JSON-LD in an HTML page.
 * Looks for @type matching Painting/VisualArtwork/Artwork. Pure (testable).
 */
export function jsonldQuery(html: string): string {
  const root = parse(html);
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.rawText || script.text);
    } catch {
      continue;
    }
    for (const obj of iterObjects(data)) {
      const typ = String(obj['@type'] ?? '').toLowerCase();
      if (!/painting|visualartwork|artwork/.test(typ)) continue;
      let nameVal = obj['name'];
      if (!nameVal) continue;
      if (Array.isArray(nameVal)) nameVal = nameVal[0] ?? '';
      const name = String(nameVal).trim();
      if (!name) continue;
      const creator = creatorName(obj['creator'] ?? obj['author']);
      return [name, creator].filter(Boolean).join(' ').trim();
    }
  }
  return '';
}

const ASSET_RE = /\/asset\/([^/?#]+)/;

/**
 * Derive an artwork search query from a URL without the user typing anything.
 *
 * - Google Arts & Culture `/asset/<slug>` → decode the slug (hyphens/underscores → spaces)
 * - Otherwise: GET the page, try JSON-LD schema.org, then og:title, then <title>
 *   — all run through cleanTitle to strip site/museum suffixes and bot-walls.
 */
export async function queryFromUrl(url: string): Promise<string> {
  const assetMatch = ASSET_RE.exec(url);
  if (url.includes('/asset/') && assetMatch) {
    return assetMatch[1].replace(/[-_]+/g, ' ').trim();
  }

  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    });
    html = await res.text();
  } catch {
    return '';
  }

  let t = jsonldQuery(html);
  if (!t) {
    const root = parse(html);
    const og = root.querySelector('meta[property="og:title"]');
    if (og) t = og.getAttribute('content') ?? '';
    if (!t) {
      const titleEl = root.querySelector('title');
      t = titleEl ? titleEl.text : '';
    }
  }
  return cleanTitle(t);
}

/**
 * Fast probe: does the URL resolve to an actual video (not an image page)?
 * Spawns `yt-dlp --simulate` and checks the extension of the first item.
 * Resolves `false` on any error or if yt-dlp is not installed.
 */
export function hasVideo(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn('yt-dlp', [
        '--quiet', '--no-warnings', '--simulate',
        '--playlist-items', '1',
        '--socket-timeout', '10',
        '--print', '%(ext)s',
        url,
      ], { timeout: 60_000 });
    } catch {
      resolve(false);
      return;
    }
    p.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    p.on('error', () => resolve(false));
    p.on('close', () => {
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      resolve(lines.length > 0 && VIDEO_EXTS.has(lines[0]));
    });
  });
}
