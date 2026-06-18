/**
 * Shared helpers for museum source adapters.
 * Pure utility functions (no I/O) plus the timedFetch wrapper.
 */
import { fetch } from 'undici';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const TIMEOUT_MS = 12_000;
export const MAX_ITEMS = 40;

// Lossless raster formats — JPEG/WEBP(lossy) are NOT here.
export const LOSSLESS_FORMATS = new Set(['png', 'tiff', 'gif', 'bmp']);

export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  // Objects / arrays: do NOT pass through — coerce to empty string to prevent
  // React error #31 ("Objects are not valid as a React child").
  return '';
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function fmtFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('tiff')) return 'tiff';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'jpeg';
}

export function fmtFromUrl(url: string): string {
  const m = url.toLowerCase().match(/\.(jpe?g|png|tiff?|webp|gif|bmp)(?:[?#]|$)/);
  if (!m) return 'jpeg';
  const ext = m[1];
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  return ext;
}

export function first(v: unknown): string {
  if (Array.isArray(v)) return v.length ? str(v[0]) : '';
  return str(v);
}

export async function timedFetch(url: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    signal,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }) as unknown as Response;
}

// ─── IIIF image URL helpers ───────────────────────────────────────────────────

/** Named size strings for the most common IIIF thumbnail sizes. */
export const IIIF = {
  /** Best-fit, max 843 × 843 px — used for thumbnails by V&A, Wellcome, Harvard. */
  THUMB: '!843,843',
  /** Best-fit, max 1600 × 1600 px — used for lightbox previews. */
  PREVIEW: '!1600,1600',
  /** Native resolution. */
  FULL: 'full',
} as const;

export type IiifSize = string; // any valid IIIF size string

/**
 * Build a standard IIIF image URL.
 *
 * @param base   The IIIF image base URL (without trailing slash).
 * @param size   A IIIF size string such as IIIF.THUMB, IIIF.PREVIEW, IIIF.FULL.
 */
export function iiifImage(
  base: string,
  size: IiifSize,
  rotation = 0,
  quality = 'default',
  format = 'jpg',
): string {
  return `${base}/full/${size}/${rotation}/${quality}.${format}`;
}

// ─── Bounded-concurrency map ──────────────────────────────────────────────────

/**
 * Bounded-concurrency map: runs `fn` over `items` with at most `limit` in
 * flight at once. Used to fan out the Europeana per-country queries in small
 * waves instead of one 31-connection burst — keeps full country coverage while
 * staying friendly to Europeana's rate limit and undici's per-origin pool.
 * Never rejects: a failing item resolves to `null` (callers filter those out).
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
