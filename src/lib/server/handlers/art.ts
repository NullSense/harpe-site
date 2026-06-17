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
 *   - 12 second per-source timeout (results stream in, so slow public APIs like
 *     Library of Congress / Europeana can finish late instead of being aborted)
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch, Agent } from 'undici';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { rankResults } from '@harpe/core';
import { qualityScore } from '../../ranking.js';

// HTTP/2 dispatcher (lazy). NYPL's HTTP/1.1 path returns "HTTP Basic: Access
// denied" and ignores the Token auth scheme; over HTTP/2 (what curl uses) the
// Token is honoured. undici defaults to HTTP/1.1, so NYPL needs this explicitly.
let _h2: Agent | undefined;
function h2Agent(): Agent {
  return (_h2 ??= new Agent({ allowH2: true }));
}

// ─── Constants ────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;
const MAX_ITEMS = 40;

// ─── Response types ───────────────────────────────────────────────────────────

// A single downloadable file variant for a work. Sources often expose more than
// one (e.g. a high-res JPEG and a lossless TIFF original) — we surface them all
// so the UI can show format/quality and let the user choose.
interface Download {
  label: string;     // "High-res JPEG", "Original TIFF" …
  url: string;       // direct upstream URL (downloaded via /api/fetch proxy)
  format: string;    // 'jpeg' | 'png' | 'tiff' | 'webp' | 'gif'
  lossless: boolean; // true for png/tiff/gif/bmp originals
}

export interface ArtItem {
  id: string;
  title: string;
  artist: string;
  dimensions: string;
  thumbUrl: string;     // small image for the grid card
  previewUrl: string;   // larger BROWSER-RENDERABLE image for the lightbox
  fullUrl: string;      // primary/default download URL
  width?: number;       // pixel width when the source reports it
  height?: number;      // pixel height when the source reports it
  format: string;       // format of the primary download
  lossless: boolean;    // true if ANY download variant is lossless
  downloads: Download[];
  source: 'aic' | 'met' | 'cleveland' | 'commons' | 'wikiart' | 'vam' | 'wellcome' | 'smk' | 'nasjonalmuseet' | 'digitalnz' | 'wikidata' | 'europeana' | 'harvard' | 'si' | 'parismusees' | 'moma' | 'nga' | 'mia' | 'loc' | 'nypl' | 'dumps';
  isPublicDomain: boolean;
  // ── Enrichment (optional; the union "mega-model" beyond the basics above) ──
  date?: string;        // display date, e.g. "1642" / "ca. 1665"
  medium?: string;      // materials/technique, e.g. "Oil on canvas"
  culture?: string;     // culture / place of origin
  creditLine?: string;  // acquisition / credit line
  description?: string; // prose description / curatorial note (source-provided)
  sourceUrl?: string;   // canonical page for this work at the source
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

// Lossless raster formats — JPEG/WEBP(lossy) are NOT here.
const LOSSLESS_FORMATS = new Set(['png', 'tiff', 'gif', 'bmp']);

function fmtFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('tiff')) return 'tiff';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'jpeg';
}

function fmtFromUrl(url: string): string {
  const m = url.toLowerCase().match(/\.(jpe?g|png|tiff?|webp|gif|bmp)(?:[?#]|$)/);
  if (!m) return 'jpeg';
  const ext = m[1];
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  return ext;
}

// Relevance, fuzzy matching, the gate, RRF fusion (search.ts) and the quality
// prior (ranking.ts) all live in shared, unit-tested modules — imported above —
// so the server and client rank identically with no duplicated logic.

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
      `?q=${encodeURIComponent(q)}&fields=id,title,artist_title,image_id,is_public_domain,dimensions,date_display,medium_display,description,place_of_origin,credit_line&limit=12`;

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
        date_display?: unknown;
        medium_display?: unknown;
        description?: unknown;
        place_of_origin?: unknown;
        credit_line?: unknown;
      }>;
      config?: { iiif_url?: unknown };
    };

    const iiif = str(json.config?.iiif_url) || 'https://www.artic.edu/iiif/2';
    const items: ArtItem[] = [];

    for (const d of json.data ?? []) {
      const imageId = str(d.image_id);
      if (!imageId) continue;

      const base = `${iiif}/${imageId}`;
      const fullUrl = `${base}/full/full/0/default.jpg`;
      items.push({
        id: `aic-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist: str(d.artist_title),
        dimensions: String(d.dimensions ?? ''),
        thumbUrl: `${base}/full/843,/0/default.jpg`,
        previewUrl: `${base}/full/1686,/0/default.jpg`,
        fullUrl,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: fullUrl, format: 'jpeg', lossless: false }],
        source: 'aic',
        isPublicDomain: Boolean(d.is_public_domain),
        date: str(d.date_display),
        medium: str(d.medium_display),
        culture: str(d.place_of_origin),
        creditLine: str(d.credit_line),
        description: str(d.description).replace(/<[^>]+>/g, ''), // strip HTML
        sourceUrl: `https://www.artic.edu/artworks/${str(d.id)}`,
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
        objectDate?: unknown;
        medium?: unknown;
        creditLine?: unknown;
        objectURL?: unknown;
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
        previewUrl: primaryImage,
        fullUrl: primaryImage,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: primaryImage, format: 'jpeg', lossless: false }],
        source: 'met',
        date: str(d.objectDate),
        medium: str(d.medium),
        culture: str(d.culture),
        creditLine: str(d.creditLine),
        sourceUrl: str(d.objectURL),
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
        description?: unknown;
        tombstone?: unknown;
        creation_date?: unknown;
        technique?: unknown;
        culture?: unknown[];
        url?: unknown;
        images?: {
          web?: { url?: unknown };
          print?: { url?: unknown };
          full?: { url?: unknown };
        };
      }>;
    };

    const items: ArtItem[] = [];
    for (const d of json.data ?? []) {
      const images = (d.images ?? {}) as {
        web?: { url?: unknown; width?: unknown; height?: unknown };
        print?: { url?: unknown; width?: unknown; height?: unknown };
        full?: { url?: unknown; width?: unknown; height?: unknown };
      };
      // Cleveland exposes 3 variants: `web` JPEG (~250KB), `print` JPEG (~3MB),
      // and `full` TIFF (lossless original, tens of MB). Browsers can't render
      // TIFF, so it is NEVER used for display — only offered as a download.
      const webUrl = str(images.web?.url);
      const printUrl = str(images.print?.url);
      const tifUrl = str(images.full?.url);
      const thumbUrl = webUrl || printUrl;
      const previewUrl = printUrl || webUrl; // JPEG — renderable in the lightbox
      if (!thumbUrl) continue;

      const downloads: Download[] = [];
      if (printUrl) downloads.push({ label: 'High-res JPEG', url: printUrl, format: 'jpeg', lossless: false });
      else if (webUrl) downloads.push({ label: 'JPEG', url: webUrl, format: 'jpeg', lossless: false });
      if (tifUrl) downloads.push({ label: 'Original TIFF', url: tifUrl, format: 'tiff', lossless: true });
      const fullUrl = downloads[0]?.url ?? thumbUrl;

      const artist =
        (d.creators?.[0] !== undefined ? str(d.creators[0].description) : '') || '';

      // Cleveland's `dimensions` field is an OBJECT — do NOT use it.
      // Use `measurements` (a string field) when available; otherwise empty string.
      const dimensions = typeof d.measurements === 'string' ? d.measurements : '';
      // Pixel size of the largest available variant (TIFF original → print → web).
      const px = images.full ?? images.print ?? images.web ?? {};

      items.push({
        id: `cleveland-${str(d.id)}`,
        title: str(d.title) || 'Untitled',
        artist,
        dimensions,
        thumbUrl,
        previewUrl,
        fullUrl,
        width: Number(px.width) || undefined,
        height: Number(px.height) || undefined,
        format: 'jpeg',
        lossless: downloads.some((dl) => dl.lossless),
        downloads,
        source: 'cleveland',
        isPublicDomain: str(d.share_license_status).toUpperCase() === 'CC0',
        date: str(d.creation_date),
        medium: str(d.technique),
        culture: Array.isArray(d.culture) ? d.culture.map(str).filter(Boolean).join(', ') : '',
        description: str(d.description) || str(d.tombstone),
        sourceUrl: str(d.url),
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
      `&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=1024`;

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
      const mime = str(ii.mime);
      if (!/^image\/(jpeg|png|tiff|webp)/.test(mime)) continue;
      const full = str(ii.url);
      if (!full) continue;
      const w = Number(ii.width) || 0;
      const h = Number(ii.height) || 0;
      const title = str(p.title).replace(/^File:/, '').replace(/\.[A-Za-z0-9]+$/, '');
      // The rendered thumbnail (`thumburl`) is always a browser-renderable JPEG/PNG
      // even when the original is a TIFF, so it's safe for both the card and lightbox.
      const rendered = str(ii.thumburl) || full;
      const format = fmtFromMime(mime);
      const lossless = LOSSLESS_FORMATS.has(format);
      items.push({
        id: `commons-${title}`,
        title: title || 'Untitled',
        artist: '',
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: rendered,
        previewUrl: rendered,
        fullUrl: full,
        width: w || undefined,
        height: h || undefined,
        format,
        lossless,
        downloads: [{ label: `Original ${format.toUpperCase()}`, url: full, format, lossless }],
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
      const original = image.replace(/!.*$/, ''); // strip variant suffix → original
      const format = fmtFromUrl(original);
      items.push({
        id: `wikiart-${str(d.id)}`,
        title: (str(d.title) || 'Untitled') + year,
        artist: str(d.artistName),
        dimensions: w && h ? `${w} × ${h} px` : '',
        thumbUrl: image, // the "!Large.jpg" variant
        previewUrl: image,
        fullUrl: original,
        width: w || undefined,
        height: h || undefined,
        format,
        lossless: LOSSLESS_FORMATS.has(format),
        downloads: [{ label: `Original ${format.toUpperCase()}`, url: original, format, lossless: LOSSLESS_FORMATS.has(format) }],
        source: 'wikiart',
        isPublicDomain: false, // WikiArt is mixed-rights; badge a rights caution
        date: str(d.completitionYear),
      });
    }

    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Victoria & Albert Museum (UK; keyless v2 API, IIIF images) ───────────────

async function fetchVam(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url =
      `https://api.vam.ac.uk/v2/objects/search` +
      `?q=${encodeURIComponent(q)}&images_exist=1&page_size=15`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      records?: Array<{
        systemNumber?: unknown;
        _primaryTitle?: unknown;
        objectType?: unknown;
        _primaryMaker?: { name?: unknown };
        _primaryDate?: unknown;
        _images?: { _iiif_image_base_url?: unknown };
      }>;
    };

    const items: ArtItem[] = [];
    for (const r of json.records ?? []) {
      const base = str(r._images?._iiif_image_base_url).replace(/\/$/, '');
      if (!base) continue;
      const date = str(r._primaryDate);
      const full = `${base}/full/full/0/default.jpg`;
      items.push({
        id: `vam-${str(r.systemNumber)}`,
        title: (str(r._primaryTitle) || str(r.objectType) || 'Untitled') + (date ? ` (${date})` : ''),
        artist: str(r._primaryMaker?.name),
        dimensions: '',
        thumbUrl: `${base}/full/!843,843/0/default.jpg`,
        previewUrl: `${base}/full/!1600,1600/0/default.jpg`,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'vam',
        isPublicDomain: false, // V&A images are mixed-rights — badge a caution
        date,
        medium: str(r.objectType),
        sourceUrl: `https://collections.vam.ac.uk/item/${str(r.systemNumber)}`,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wellcome Collection (UK; keyless catalogue API, IIIF images) ─────────────

async function fetchWellcome(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url =
      `https://api.wellcomecollection.org/catalogue/v2/works` +
      `?query=${encodeURIComponent(q)}&pageSize=15&include=items`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as {
      results?: Array<{
        id?: unknown;
        title?: unknown;
        thumbnail?: { url?: unknown };
      }>;
    };

    const items: ArtItem[] = [];
    for (const w of json.results ?? []) {
      // thumbnail: .../thumbs/<imageId>/full/!200,200/0/default.jpg — derive the
      // full IIIF image from the same imageId via the /image/ service.
      const thumb = str(w.thumbnail?.url);
      const m = thumb.match(/\/thumbs\/([^/]+)\/full\//);
      if (!m) continue;
      const base = `https://iiif.wellcomecollection.org/image/${m[1]}`;
      const full = `${base}/full/full/0/default.jpg`;
      items.push({
        id: `wellcome-${str(w.id)}`,
        title: str(w.title) || 'Untitled',
        artist: '',
        dimensions: '',
        thumbUrl: `${base}/full/!843,843/0/default.jpg`,
        previewUrl: `${base}/full/!1600,1600/0/default.jpg`,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'wellcome',
        isPublicDomain: true, // Wellcome Collection is open access (CC0/CC-BY/PD)
        sourceUrl: `https://wellcomecollection.org/works/${str(w.id)}`,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── SMK — Statens Museum for Kunst (Denmark; keyless, IIIF) ──────────────────

async function fetchSmk(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://api.smk.dk/api/v1/art/search?keys=${encodeURIComponent(q)}` +
      `&filters=%5Bhas_image%3Atrue%5D&offset=0&rows=15`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      items?: Array<{
        object_number?: unknown;
        titles?: Array<{ title?: unknown; language?: unknown }>;
        artist?: unknown;
        image_thumbnail?: unknown;
        image_iiif_id?: unknown;
        image_width?: unknown;
        image_height?: unknown;
        public_domain?: unknown;
      }>;
    };
    const items: ArtItem[] = [];
    for (const it of json.items ?? []) {
      const iiif = str(it.image_iiif_id);
      const thumb0 = str(it.image_thumbnail);
      if (!iiif && !thumb0) continue;
      const titles = it.titles ?? [];
      const en = titles.find((t) => str(t.language) === 'engelsk');
      const title = str(en?.title) || str(titles[0]?.title) || 'Untitled';
      const full = iiif ? `${iiif}/full/full/0/default.jpg` : thumb0;
      items.push({
        id: `smk-${str(it.object_number)}`,
        title,
        artist: first(it.artist),
        dimensions: '',
        thumbUrl: thumb0 || `${iiif}/full/!843,/0/default.jpg`,
        previewUrl: iiif ? `${iiif}/full/!1600,/0/default.jpg` : thumb0,
        fullUrl: full,
        width: Number(it.image_width) || undefined,
        height: Number(it.image_height) || undefined,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'smk',
        isPublicDomain: Boolean(it.public_domain),
        sourceUrl: `https://open.smk.dk/en/artwork/image/${str(it.object_number)}`,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Nasjonalmuseet (Norway; keyless, IIIF) ───────────────────────────────────

async function fetchNasjonalmuseet(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `https://api.nasjonalmuseet.no/api/v1/objects/text-search?q=${encodeURIComponent(q)}`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      data?: Array<{
        uuid?: unknown;
        nmId?: unknown;
        inventoryNumber?: unknown;
        mainTitle?: unknown;
        labelDate?: unknown;
        objectName?: unknown;
        materialTechniqueDescription?: unknown;
        publishableDimensions?: unknown;
        creditLine?: unknown;
        production?: Array<{ person?: { name?: unknown }; role?: unknown }>;
        multimedia?: Array<{ imageUrl?: unknown; iiifUrl?: unknown; thumbnail?: unknown }>;
      }>;
    };
    const items: ArtItem[] = [];
    for (const it of (json.data ?? []).slice(0, 15)) {
      const mm = it.multimedia ?? [];
      const primary = mm.find((m) => str(m.iiifUrl)) ?? mm[0];
      if (!primary) continue;
      const iiif = str(primary.iiifUrl); // ends with /full/full/0/default.jpg
      const img = str(primary.imageUrl);
      let thumb = img, preview = img, full = img;
      if (iiif) {
        thumb = iiif.replace('/full/full/', '/full/!843,/');
        preview = iiif.replace('/full/full/', '/full/!1600,/');
        full = iiif;
      }
      if (!thumb) continue;
      // Stable, UNIQUE id: the API dropped `id`; use uuid → nmId → inventoryNumber.
      // Without one we'd emit duplicate `nasjonalmuseet-` ids → key collisions and
      // a detail view that opens the wrong/no item. Skip if none exists.
      const stableId = str(it.uuid) || str(it.nmId) || str(it.inventoryNumber);
      if (!stableId) continue;
      const artist = it.production?.find((p) => p.person && str(p.person.name))?.person;
      const title = str(it.mainTitle) || 'Untitled';
      const artistName = artist ? str(artist.name) : '';
      items.push({
        id: `nasjonalmuseet-${stableId}`,
        title,
        artist: artistName,
        dimensions: str(it.publishableDimensions),
        thumbUrl: thumb,
        previewUrl: preview,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'nasjonalmuseet',
        isPublicDomain: false, // mixed rights — badge a caution
        date: str(it.labelDate) || undefined,
        medium: str(it.materialTechniqueDescription) || str(it.objectName) || undefined,
        creditLine: str(it.creditLine) || undefined,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── DigitalNZ (New Zealand aggregator; keyless) ──────────────────────────────

async function fetchDigitalNZ(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://api.digitalnz.org/v3/records.json?text=${encodeURIComponent(q)}` +
      `&i%5Bcategory%5D=Images&per_page=15`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      search?: { results?: Array<{
        id?: unknown; title?: unknown; creator?: unknown;
        thumbnail_url?: unknown; large_thumbnail_url?: unknown;
        description?: unknown; date?: unknown; landing_url?: unknown; display_content_partner?: unknown;
      }> };
    };
    const items: ArtItem[] = [];
    for (const r of json.search?.results ?? []) {
      const thumb = str(r.thumbnail_url);
      if (!thumb) continue;
      const title = str(r.title) || 'Untitled';
      const artist = first(r.creator);
      const large = str(r.large_thumbnail_url) || thumb;
      items.push({
        id: `digitalnz-${str(r.id)}`,
        title,
        artist,
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: large,
        fullUrl: large,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Image', url: large, format: 'jpeg', lossless: false }],
        source: 'digitalnz',
        isPublicDomain: false, // mixed rights — badge a caution
        date: first(r.date).slice(0, 10), // trim ISO timestamps to YYYY-MM-DD
        description: first(r.description),
        culture: str(r.display_content_partner),
        sourceUrl: first(r.landing_url),
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wikidata (keyless; covers museums with no API of their own) ──────────────
// Full-text entity search (MWAPI) → keep items that have a P18 image, with the
// creator (P170) and holding collection (P195). This is how works from the
// Louvre, Prado, Rijksmuseum, Uffizi, etc. (no usable API) reach the search:
// their pieces are modelled in Wikidata with Commons images.

async function fetchWikidata(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const safe = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ');
    const sparql =
      `SELECT ?item ?itemLabel ?itemDescription ?image ?creatorLabel ?collectionLabel ?inception ?materialLabel ?genreLabel WHERE {` +
      ` SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org";` +
      ` wikibase:api "EntitySearch"; mwapi:search "${safe}"; mwapi:language "en".` +
      ` ?item wikibase:apiOutputItem mwapi:item. }` +
      ` ?item wdt:P18 ?image.` +
      ` OPTIONAL { ?item wdt:P170 ?creator. }` +
      ` OPTIONAL { ?item wdt:P195 ?collection. }` +
      ` OPTIONAL { ?item wdt:P571 ?inception. }` +
      ` OPTIONAL { ?item wdt:P186 ?material. }` +
      ` OPTIONAL { ?item wdt:P136 ?genre. }` +
      ` SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 25`;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      results?: { bindings?: Array<Record<string, { value?: unknown }>> };
    };

    const items: ArtItem[] = [];
    const seenItems = new Set<string>();
    for (const b of json.results?.bindings ?? []) {
      const itemUri = str(b.item?.value);
      if (!itemUri || seenItems.has(itemUri)) continue; // dedupe item × creator × collection rows
      const rawImage = str(b.image?.value);
      if (!rawImage) continue;
      seenItems.add(itemUri);
      // Commons Special:FilePath URL — upgrade to https; size via ?width=
      const fileBase = rawImage.replace(/^http:/, 'https:');
      const collection = str(b.collectionLabel?.value);
      const sep = fileBase.includes('?') ? '&' : '?';
      const genre = str(b.genreLabel?.value);
      items.push({
        id: `wikidata-${itemUri.split('/').pop()}`,
        title: str(b.itemLabel?.value) || 'Untitled',
        artist: str(b.creatorLabel?.value),
        dimensions: '', // no pixel dims from P18 — the UI derives resolution from the image
        thumbUrl: `${fileBase}${sep}width=843`,
        previewUrl: `${fileBase}${sep}width=1600`,
        fullUrl: fileBase,
        format: fmtFromUrl(fileBase),
        lossless: false,
        downloads: [{ label: 'Full image', url: fileBase, format: fmtFromUrl(fileBase), lossless: false }],
        source: 'wikidata',
        isPublicDomain: true, // P18 images live on Commons (freely licensed)
        date: str(b.inception?.value).slice(0, 4),
        medium: str(b.materialLabel?.value), // P186 material/technique
        culture: genre,                       // P136 genre (e.g. "history painting")
        creditLine: collection,               // P195 holding collection
        description: str(b.itemDescription?.value),
        sourceUrl: itemUri,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Keyed sources (dormant until their env key is set) ───────────────────────
// These read a free API key from a server-only env var. The key NEVER reaches
// the browser (Vite only bundles VITE_-prefixed vars; these run in the
// serverless function). Each fetcher is only added to the fan-out when its key
// is present, so the site works fully without any of them.

function first(v: unknown): string {
  if (Array.isArray(v)) return v.length ? str(v[0]) : '';
  return str(v);
}

// Europeana — aggregates 3,000+ European institutions. Free key: EUROPEANA_API_KEY
async function fetchEuropeana(q: string): Promise<ArtItem[]> {
  const key = process.env.EUROPEANA_API_KEY!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://api.europeana.eu/record/v2/search.json?wskey=${encodeURIComponent(key)}` +
      `&query=${encodeURIComponent(q)}&qf=TYPE:IMAGE&reusability=open&media=true&thumbnail=true&rows=15`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      items?: Array<{
        title?: unknown; dcCreator?: unknown; edmPreview?: unknown;
        edmIsShownBy?: unknown; isShownBy?: unknown; guid?: unknown; id?: unknown;
        dcDescription?: unknown; year?: unknown; dataProvider?: unknown; edmIsShownAt?: unknown;
      }>;
    };
    const items: ArtItem[] = [];
    for (const it of json.items ?? []) {
      const thumb = first(it.edmPreview);
      const full = first(it.edmIsShownBy) || first(it.isShownBy) || thumb;
      if (!thumb) continue;
      items.push({
        id: `europeana-${str(it.id) || str(it.guid)}`,
        title: first(it.title) || 'Untitled',
        artist: first(it.dcCreator),
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full || thumb,
        fullUrl: full || thumb,
        format: fmtFromUrl(full || thumb),
        lossless: LOSSLESS_FORMATS.has(fmtFromUrl(full || thumb)),
        downloads: [{ label: 'Full image', url: full || thumb, format: fmtFromUrl(full || thumb), lossless: false }],
        source: 'europeana',
        isPublicDomain: true, // reusability=open filter
        date: first(it.year),
        culture: first(it.dataProvider),
        description: first(it.dcDescription),
        sourceUrl: first(it.edmIsShownAt) || str(it.guid),
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Harvard Art Museums. Free key: HARVARD_API_KEY
async function fetchHarvard(q: string): Promise<ArtItem[]> {
  const key = process.env.HARVARD_API_KEY!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://api.harvardartmuseums.org/object?apikey=${encodeURIComponent(key)}` +
      `&keyword=${encodeURIComponent(q)}&hasimage=1&size=20&sort=rank`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      records?: Array<{
        id?: unknown; title?: unknown; dated?: unknown;
        people?: Array<{ name?: unknown; role?: unknown }>;
        primaryimageurl?: unknown; iiifbaseuri?: unknown; imagepermissionlevel?: unknown;
        description?: unknown; medium?: unknown; culture?: unknown; creditline?: unknown; url?: unknown;
      }>;
    };
    const items: ArtItem[] = [];
    for (const r of json.records ?? []) {
      // imagepermissionlevel 0 = freely usable; require a primary image.
      if (Number(r.imagepermissionlevel) !== 0) continue;
      const primary = str(r.primaryimageurl);
      if (!primary) continue;
      const iiif = str(r.iiifbaseuri);
      const date = str(r.dated);
      const artist = (r.people?.find((p) => str(p.role) === 'Artist') ?? r.people?.[0]);
      items.push({
        id: `harvard-${str(r.id)}`,
        title: (str(r.title) || 'Untitled') + (date ? ` (${date})` : ''),
        artist: artist ? str(artist.name) : '',
        dimensions: '',
        thumbUrl: iiif ? `${iiif}/full/!843,843/0/default.jpg` : `${primary}?height=843`,
        previewUrl: iiif ? `${iiif}/full/!1600,1600/0/default.jpg` : primary,
        fullUrl: primary,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: primary, format: 'jpeg', lossless: false }],
        source: 'harvard',
        isPublicDomain: true, // imagepermissionlevel 0
        date,
        medium: str(r.medium),
        culture: str(r.culture),
        creditLine: str(r.creditline),
        description: str(r.description),
        sourceUrl: str(r.url),
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Smithsonian Open Access (CC0). Free key: SMITHSONIAN_API_KEY
async function fetchSmithsonian(q: string): Promise<ArtItem[]> {
  const key = process.env.SMITHSONIAN_API_KEY!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://api.si.edu/openaccess/api/v1.0/search?api_key=${encodeURIComponent(key)}` +
      `&q=${encodeURIComponent(`${q} AND online_media_type:Images`)}&rows=15`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      response?: { rows?: Array<{
        id?: unknown; title?: unknown;
        content?: {
          freetext?: { name?: Array<{ content?: unknown }> };
          descriptiveNonRepeating?: { online_media?: { media?: Array<{ thumbnail?: unknown; content?: unknown; type?: unknown }> } };
        };
      }> };
    };
    const items: ArtItem[] = [];
    for (const r of json.response?.rows ?? []) {
      const media = r.content?.descriptiveNonRepeating?.online_media?.media ?? [];
      const m = media.find((x) => str(x.type) === 'Images') ?? media[0];
      const thumb = str(m?.thumbnail);
      const full = str(m?.content) || thumb;
      if (!thumb) continue;
      items.push({
        id: `si-${str(r.id)}`,
        title: str(r.title) || 'Untitled',
        artist: first(r.content?.freetext?.name?.map((n) => str(n.content)).filter(Boolean)),
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full || thumb,
        fullUrl: full || thumb,
        format: fmtFromUrl(full || thumb),
        lossless: false,
        downloads: [{ label: 'Full image', url: full || thumb, format: fmtFromUrl(full || thumb), lossless: false }],
        source: 'si',
        isPublicDomain: true, // Smithsonian Open Access is CC0
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Paris Musées (14 Paris museums; GraphQL, free token). PARIS_MUSEES_TOKEN
// NOTE: GraphQL search syntax is best-effort — verify once the token is live.
async function fetchParisMusees(q: string): Promise<ArtItem[]> {
  const token = process.env.PARIS_MUSEES_TOKEN!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const query =
      `{ nodeQuery(filter: {conditions: [` +
      `{field: "type", value: "oeuvre"}, ` +
      `{field: "title", operator: LIKE, value: ${JSON.stringify('%' + q + '%')}}` +
      `]}, limit: 15) { entities { entityLabel ... on NodeOeuvre {` +
      ` title fieldVisuels { entity { publicUrl vignette } } } } } }`;
    const res = await fetch('https://apicollections.parismusees.paris.fr/graphql', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'auth-token': token, 'User-Agent': UA },
      body: JSON.stringify({ query }),
    }) as unknown as Response;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      data?: { nodeQuery?: { entities?: Array<{
        entityLabel?: unknown; title?: unknown;
        fieldVisuels?: Array<{ entity?: { publicUrl?: unknown; vignette?: unknown } }>;
      }> } };
      errors?: Array<{ message?: unknown }>;
    };
    // Surface GraphQL errors instead of silently returning nothing.
    if (json.errors?.length) throw new Error(`GraphQL: ${str(json.errors[0].message).slice(0, 120)}`);
    const items: ArtItem[] = [];
    for (const e of json.data?.nodeQuery?.entities ?? []) {
      const v = e.fieldVisuels?.[0]?.entity;
      const img = str(v?.publicUrl) || str(v?.vignette);
      if (!img) continue;
      items.push({
        id: `parismusees-${str(e.entityLabel)}-${items.length}`,
        title: str(e.title) || str(e.entityLabel) || 'Untitled',
        artist: '',
        dimensions: '',
        thumbUrl: str(v?.vignette) || img,
        previewUrl: img,
        fullUrl: img,
        format: fmtFromUrl(img),
        lossless: false,
        downloads: [{ label: 'Full image', url: img, format: fmtFromUrl(img), lossless: false }],
        source: 'parismusees',
        isPublicDomain: true,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// Dump-backed source: our own metadata Parquet on Hugging Face, queried via HF's
// keyless /search. Covers museums with no live API (MoMA, NGA, …) ingested by
// scripts/ingest-art-dumps/ingest.py. Dormant until HARPE_DUMP_DATASET is set.
async function fetchDumps(q: string): Promise<ArtItem[]> {
  const dataset = process.env.HARPE_DUMP_DATASET!;
  const controller = new AbortController();
  // HF's /search can be slow when its index is cold — give it more headroom than
  // the per-museum timeout so it doesn't abort on the first hit after idle.
  const timer = setTimeout(() => controller.abort(), 13_000);
  try {
    const url =
      `https://datasets-server.huggingface.co/search?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=train&query=${encodeURIComponent(q)}&offset=0&length=20`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { rows?: Array<{ row?: Record<string, unknown> }> };
    const items: ArtItem[] = [];
    for (const { row } of json.rows ?? []) {
      if (!row) continue;
      const thumb = str(row.image_thumb) || str(row.image_full);
      const full = str(row.image_full) || thumb;
      if (!thumb) continue;
      const rs = str(row.source);
      const source = (rs === 'moma' || rs === 'nga' || rs === 'mia') ? rs : 'dumps';
      items.push({
        id: str(row.id) || `dumps-${items.length}`,
        title: str(row.title) || 'Untitled',
        artist: str(row.artist),
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full,
        fullUrl: full,
        format: fmtFromUrl(full),
        lossless: false,
        downloads: [{ label: 'Full image', url: full, format: fmtFromUrl(full), lossless: false }],
        source: source as ArtItem['source'],
        isPublicDomain: row.is_public_domain !== false,
        date: str(row.date),
        medium: str(row.medium),
        creditLine: str(row.credit_line),
        description: str(row.description),
        sourceUrl: str(row.source_url),
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Library of Congress (Prints & Photographs) ──────────────────────────────
// Keyless JSON API: any loc.gov page + ?fo=json. The /photos/ endpoint covers the
// P&P catalog — incl. the FSA/OWI archive (Dorothea Lange, Walker Evans, Russell
// Lee…) and Carol Highsmith, exactly the photographers the painting-heavy sources
// miss. Real derivatives live on tile.loc.gov; largest listed is ~1024px.
function locName(raw: string): string {
  // "lange, dorothea" → "Dorothea Lange"
  const s = raw.includes(',') ? raw.split(',').reverse().join(' ') : raw;
  return s.replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchLoc(q: string): Promise<ArtItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url =
      `https://www.loc.gov/photos/?q=${encodeURIComponent(q)}&fo=json&c=20&at=results`;
    const res = await timedFetch(url, controller.signal);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as {
      results?: Array<{
        title?: unknown; image_url?: unknown; url?: unknown; id?: unknown;
        date?: unknown; contributor?: unknown; unrestricted?: unknown;
        access_restricted?: unknown; item?: Record<string, unknown>;
      }>;
    };
    const clean = (u: string) => u.split('#')[0];
    const items: ArtItem[] = [];
    for (const r of json.results ?? []) {
      const imgs = Array.isArray(r.image_url) ? (r.image_url as unknown[]).map(str) : [];
      const usable = imgs.filter((u) => u.includes('tile.loc.gov')); // skips svg group placeholders
      if (usable.length === 0) continue;
      const lastRaw = usable[usable.length - 1];
      const full = clean(lastRaw);
      const thumb = clean(usable[0]);
      const dm = /[#&]h=(\d+)&w=(\d+)/.exec(lastRaw); // dims from the largest derivative
      const height = dm ? Number(dm[1]) : undefined;
      const width = dm ? Number(dm[2]) : undefined;
      const contributors = Array.isArray(r.contributor) ? (r.contributor as unknown[]).map(str).filter(Boolean) : [];
      const item = (r.item && typeof r.item === 'object') ? r.item : {};
      const med = Array.isArray(item.medium_brief) ? str((item.medium_brief as unknown[])[0])
        : Array.isArray(item.medium) ? str((item.medium as unknown[])[0]) : str(item.medium_brief);
      const sourceUrl = str(r.url) || str(r.id);
      const pd = r.unrestricted === true && r.access_restricted !== true;
      const digits = sourceUrl.replace(/\D+/g, '').slice(0, 12);
      items.push({
        id: `loc-${digits || items.length}`,
        title: str(r.title) || 'Untitled',
        artist: contributors.length ? locName(contributors[0]) : '',
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full,
        fullUrl: full,
        width, height,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full JPEG', url: full, format: 'jpeg', lossless: false }],
        source: 'loc',
        isPublicDomain: pd,
        date: str(r.date),
        medium: med,
        sourceUrl,
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── NYPL (New York Public Library Digital Collections) ──────────────────────
// Keyed (free token, 10k req/day). With publicDomainOnly=true the results carry
// usable imageLinks. Strong photography. Dormant until NYPL_API_TOKEN is set.
// DEFENSIVE: only emits items where a real http(s) image URL was parsed, so a
// shape mismatch degrades to "0 results", never broken tiles.
function nyplPick(links: string[], codes: string[]): string {
  for (const c of codes) {
    const hit = links.find((u) => new RegExp(`[?&]t=${c}(?:&|$)`).test(u));
    if (hit) return hit;
  }
  return links[0] || '';
}

async function fetchNypl(q: string): Promise<ArtItem[]> {
  // Tolerate a value pasted with surrounding quotes or a `Token token=` prefix.
  const token = (process.env.NYPL_API_TOKEN || process.env.NYPL_API_KEY || '')
    .trim().replace(/^Token\s+token=/i, '').replace(/^["']|["']$/g, '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // v2 + `Authorization: Token token="…"` is the documented scheme (v1 is now
    // disabled). Must go over HTTP/2 (see h2Agent) — NYPL's HTTP/1.1 path replies
    // "HTTP Basic: Access denied" and ignores the Token scheme.
    const url =
      `https://api.repo.nypl.org/api/v2/items/search?q=${encodeURIComponent(q)}` +
      `&publicDomainOnly=true&per_page=20`;
    const res = await fetch(url, {
      dispatcher: h2Agent(),   // NYPL honours the Token scheme only over HTTP/2
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Token token="${token}"` },
    } as Parameters<typeof fetch>[1]) as unknown as Response;
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${b.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    const json = await res.json() as { nyplAPI?: { response?: { result?: unknown } } };
    const raw = json.nyplAPI?.response?.result;
    const results = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const items: ArtItem[] = [];
    for (const r0 of results) {
      const r = r0 as Record<string, unknown>;
      const ilNode = (r.imageLinks && typeof r.imageLinks === 'object')
        ? (r.imageLinks as Record<string, unknown>).imageLink : undefined;
      let links = (Array.isArray(ilNode) ? ilNode.map(str) : ilNode ? [str(ilNode)] : [])
        .map((u) => u.replace(/&amp;/g, '&').trim())      // NYPL HTML-encodes & in links
        .map((u) => (u.startsWith('//') ? `https:${u}` : u))
        .filter((u) => /^https?:/i.test(u));
      const imageID = str(r.imageID);
      if (links.length === 0 && imageID) links = [`https://images.nypl.org/index.php?id=${imageID}&t=w`];
      const full = nyplPick(links, ['g', 'v', 'q', 'w']);
      if (!/^https?:/i.test(full)) continue; // safety: never emit a broken tile
      const thumb = nyplPick(links, ['w', 'r', 't']) || full;
      const uuid = str(r.uuid);
      items.push({
        id: `nypl-${uuid || items.length}`,
        title: str(r.title) || 'Untitled',
        artist: '',
        dimensions: '',
        thumbUrl: thumb,
        previewUrl: full,
        fullUrl: full,
        format: 'jpeg',
        lossless: false,
        downloads: [{ label: 'Full image', url: full, format: 'jpeg', lossless: false }],
        source: 'nypl',
        isPublicDomain: true,
        date: str(r.dateDigitized),
        sourceUrl: uuid ? `https://digitalcollections.nypl.org/items/${uuid}` : '',
      });
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Source list builder ──────────────────────────────────────────────────────

/**
 * Build the full list of [name, promise] source pairs for a query.
 * Reused by both the batch handler (art.ts) and the streaming handler
 * (art-stream.ts) so the source list is defined in exactly one place.
 */
export async function gatherSources(q: string): Promise<Array<[string, Promise<ArtItem[]>]>> {
  const sources: Array<[string, Promise<ArtItem[]>]> = [
    ['AIC', fetchAic(q)],
    ['Met', fetchMet(q)],
    ['Cleveland', fetchCleveland(q)],
    ['Commons', fetchCommons(q)],
    ['WikiArt', fetchWikiArt(q)],
    ['V&A', fetchVam(q)],
    ['Wellcome', fetchWellcome(q)],
    ['SMK', fetchSmk(q)],
    ['Nasjonalmuseet', fetchNasjonalmuseet(q)],
    ['DigitalNZ', fetchDigitalNZ(q)],
    ['Wikidata', fetchWikidata(q)],
    ['Library of Congress', fetchLoc(q)],
  ];
  // Keyed sources: only queried when their (server-only) API key is configured.
  if (process.env.EUROPEANA_API_KEY) sources.push(['Europeana', fetchEuropeana(q)]);
  if (process.env.HARVARD_API_KEY) sources.push(['Harvard', fetchHarvard(q)]);
  if (process.env.SMITHSONIAN_API_KEY) sources.push(['Smithsonian', fetchSmithsonian(q)]);
  // NYPL live API is DISABLED on Vercel: its token auth only works over HTTP/2,
  // but Vercel's serverless egress forces HTTP/1.1 (where NYPL replies "HTTP
  // Basic: Access denied" and ignores the Token scheme). Verified: the same code
  // succeeds over HTTP/2 locally. Re-enable if egress ever supports h2, or run
  // NYPL via its bulk public-domain dump instead. Photography is covered by LoC.
  void fetchNypl;
  // if (process.env.NYPL_API_TOKEN || process.env.NYPL_API_KEY) sources.push(['NYPL', fetchNypl(q)]);
  if (process.env.PARIS_MUSEES_TOKEN) sources.push(['Paris Musées', fetchParisMusees(q)]);
  if (process.env.HARPE_DUMP_DATASET) sources.push(['Dumps', fetchDumps(q)]);
  // Note: Paris Musées' Drupal GraphQL has no fast fulltext index — the LIKE scan
  // can be slow/empty. It's best-effort: its own timeout caps latency and a slow
  // or failing call just degrades to a per-source warning (the 14 Paris museums
  // are also covered by Europeana).
  return sources;
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
  const sources = await gatherSources(q);
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

  // De-dup, gate out non-matching fallback hits, and rank with Reciprocal Rank
  // Fusion — one shared pipeline (src/lib/search.ts) used identically by the
  // client. Fixes "Rodin Thinker" → other Rodin works, and "JW Waterhouse" →
  // unrelated AIC/MoMA fallbacks leaking in.
  const capped = rankResults(items, q, { qualityOf: (it) => qualityScore(it, q) }).slice(0, MAX_ITEMS);

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    items: capped, warnings,
    analyzeEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY),
  });
}
