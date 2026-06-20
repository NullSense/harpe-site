/**
 * Shared helpers for museum source adapters.
 * Pure utility functions (no I/O) plus the timedFetch wrapper.
 */
import { fetch } from 'undici';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Unified search timing budget ──────────────────────────────────────────────
// One source of truth for every deadline in the search hot path, shared by the
// live per-source timeout (resilience.sourcePolicy), the dump HF /filter policy
// (resilience.makeDumpHttpPolicy) and the streaming/batch overall deadline
// (art-stream OVERALL_TIMEOUT_MS). The invariant — LIVE < DUMP_WORST_CASE ≤
// OVERALL — is asserted in budget.test.ts so the overall deadline can never again
// be set BELOW the dump worst case (the shipped defect: a 9s stream cap killed the
// ~16s cold dump call, so the user saw only weak live sources, never the
// dump-backed bulk that holds the best results).

/** Per live-API source deadline. Live sources are SUPPLEMENTARY now (the dump is
 *  the spine), so they get a tight budget and can't dominate the response. Also
 *  the default for helpers.deadline(). */
export const TIMEOUT_MS = 6_000;

/** Per-attempt deadline for the shared HF /filter call (all dump sources ride it). */
export const DUMP_TIMEOUT_MS = 8_000;
/** Cockatiel retry count for the dump call — the number of RETRIES, NOT total
 *  invocations: total attempts = DUMP_RETRIES + 1. (cockatiel's RetryPolicy loops
 *  while `retries < maxAttempts`, so maxAttempts=2 runs 3 times.) Two retries ride
 *  out a transient HF blip; pinned to the real library behavior in resilience.test.ts. */
export const DUMP_RETRIES = 2;
/** Max exponential-backoff delay per retry gap — mirrors the maxDelay in
 *  resilience.makeDumpHttpPolicy. There are DUMP_RETRIES such gaps in the worst case. */
export const DUMP_BACKOFF_MAX_MS = 1_000;
/** Worst-case wall time for the dump call: every attempt times out AND every retry
 *  waits the max backoff. Total attempts = DUMP_RETRIES + 1, backoff gaps = DUMP_RETRIES. */
export const DUMP_WORST_CASE_MS =
  DUMP_TIMEOUT_MS * (DUMP_RETRIES + 1) + DUMP_RETRIES * DUMP_BACKOFF_MAX_MS;
/** Best-effort budget for the per-source KG enrichment that runs AFTER a source
 *  resolves (enrichArtistIds + enrichWorkIds — the work_index shard fetches, and the
 *  one-time name_to_qid load on a cold instance). Enrichment is additive metadata, so
 *  if it overruns we deliver the source's results un-/partially-enriched rather than
 *  hold them — and the slow load still completes + memoises in the background for the
 *  next query. This is what decouples DELIVERY from enrichment. See registry.gatherSources. */
export const ENRICH_BUDGET_MS = 2_500;
/** Overall deadline for a search (stream hard cap / batch budget). Must cover the full
 *  dump critical path — the dump worst case PLUS its enrichment budget — so the response
 *  never ends with the best results still pending. */
export const OVERALL_TIMEOUT_MS = DUMP_WORST_CASE_MS + ENRICH_BUDGET_MS + 2_000;

export const MAX_ITEMS = 50;

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

/** Best-effort budget: settle when `p` resolves/rejects OR after `ms`, whichever is
 *  first. Never rejects and never returns a value — it exists to cap a side-effecting,
 *  in-place task (e.g. KG enrichment that mutates the items array) so a slow/failed run
 *  can't hold up delivery. The underlying promise keeps running in the background (any
 *  memoised load it performs still completes for the next caller). */
export async function raceBudget(ms: number, p: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([p.then(() => {}, () => {}), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * Resolve the AbortSignal an adapter should use for its fetch deadline.
 *
 * In production the resilience layer's cooperative timeout policy supplies a
 * signal (already counting down) — we just pass it through, and `clear()` is a
 * no-op (the policy owns the timer). When an adapter is called directly with no
 * signal (CLI / tests), we fall back to a self-managed AbortController + timer so
 * it still enforces its own deadline. Replaces the per-adapter boilerplate.
 */
export function deadline(signal: AbortSignal | undefined, ms = TIMEOUT_MS): { signal: AbortSignal; clear: () => void } {
  if (signal) return { signal, clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
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
