/**
 * In-browser deep-zoom / gigapixel tile-stitcher — our own MIT implementation.
 *
 * Inspired by lovasoa's dezoomify (GPL-3.0) in *approach only* — none of its code
 * is used. We support the three open zoomable-image standards that together cover
 * the overwhelming majority of museum / archive "zoomable image" viewers:
 *
 *   • IIIF Image API   — already deep-zooms via OpenSeadragon's native info.json
 *                        path AND offers a single full-res download (full/max), so
 *                        it needs no stitching. Handled here only for completeness.
 *   • DeepZoom (.dzi)  — Microsoft DZI pyramid. NO single full-res URL exists, so
 *                        the full image must be stitched from its tiles.
 *   • Zoomify          — ImageProperties.xml pyramid with TileGroup bucketing.
 *
 * All three use the same power-of-two pyramid OpenSeadragon assumes, so for VIEWING
 * we hand OSD a custom tile source (osdTileSource). For DOWNLOAD we re-use the exact
 * same tile math to fetch every tile of the deepest browser-safe level and composite
 * them onto a <canvas>, which we export as one full-resolution image.
 *
 * Tiles for the download are routed through our same-origin /api/tile CORS proxy so
 * the canvas stays un-tainted and can be exported; viewing loads tiles directly.
 *
 * The pure pyramid math (no DOM) is unit-tested in deepzoom.test.ts.
 */

export type DeepZoomProtocol = 'iiif' | 'dzi' | 'zoomify';

export interface DeepZoomDescriptor {
  protocol: DeepZoomProtocol;
  width: number;
  height: number;
  tileSize: number;
  /** Pixels each tile overlaps its neighbour (DZI only; 0 for IIIF/Zoomify). */
  overlap: number;
  /** Tile file extension WITHOUT the dot: 'jpg' | 'jpeg' | 'png' | 'webp'. */
  format: string;
  /**
   * Protocol-specific tile-URL base:
   *   iiif    → the Image-API service id (e.g. https://h/iiif/abc), no trailing slash.
   *   dzi     → descriptor URL minus ".dzi" (tiles live at `${base}_files/…`).
   *   zoomify → the directory holding ImageProperties.xml, no trailing slash.
   */
  base: string;
  title?: string;
  /** Page the image was found on (sent as Referer when fetching tiles). */
  referer?: string;
  sourceUrl?: string;
}

const LN2 = Math.LN2;

/** Deepest pyramid level (DZI / Zoomify / OpenSeadragon convention). */
export function maxLevel(d: { width: number; height: number }): number {
  return Math.ceil(Math.log(Math.max(d.width, d.height, 1)) / LN2);
}

/** Scale factor of a level relative to full resolution (level maxLevel === 1). */
export function levelScale(d: { width: number; height: number }, level: number): number {
  return 1 / (1 << (maxLevel(d) - level));
}

export function levelDimensions(
  d: { width: number; height: number },
  level: number,
): { w: number; h: number } {
  const s = levelScale(d, level);
  return { w: Math.ceil(d.width * s), h: Math.ceil(d.height * s) };
}

export function levelTiles(d: DeepZoomDescriptor, level: number): { cols: number; rows: number } {
  const { w, h } = levelDimensions(d, level);
  return { cols: Math.ceil(w / d.tileSize), rows: Math.ceil(h / d.tileSize) };
}

/** Zoomify buckets tiles into TileGroup folders of 256, ordered level-major. */
export function zoomifyTileGroup(d: DeepZoomDescriptor, level: number, col: number, row: number): number {
  let index = 0;
  for (let l = 0; l < level; l++) {
    const { cols, rows } = levelTiles(d, l);
    index += cols * rows;
  }
  const { cols } = levelTiles(d, level);
  index += row * cols + col;
  return Math.floor(index / 256);
}

/** Absolute URL of one tile (level, col, row) for the descriptor's protocol. */
export function tileUrl(d: DeepZoomDescriptor, level: number, col: number, row: number): string {
  if (d.protocol === 'dzi') {
    return `${d.base}_files/${level}/${col}_${row}.${d.format}`;
  }
  if (d.protocol === 'zoomify') {
    const g = zoomifyTileGroup(d, level, col, row);
    return `${d.base}/TileGroup${g}/${level}-${col}-${row}.${d.format}`;
  }
  // IIIF: a full-resolution region tile. (Stitch path is unused for IIIF — we
  // download full/max directly — but kept correct for completeness/testing.)
  const x = col * d.tileSize;
  const y = row * d.tileSize;
  const w = Math.min(d.tileSize, d.width - x);
  const h = Math.min(d.tileSize, d.height - y);
  return `${d.base}/${x},${y},${w},${h}/${w},/0/default.${d.format}`;
}

/** Largest level that is a single tile — a ready-made whole-image thumbnail. */
export function thumbLevel(d: DeepZoomDescriptor): number {
  const ml = maxLevel(d);
  let best = 0;
  for (let l = 0; l <= ml; l++) {
    const { cols, rows } = levelTiles(d, l);
    if (cols === 1 && rows === 1) best = l;
    else break;
  }
  return best;
}

/** Deepest level whose long edge fits within `cap` (browser canvas-safe). */
export function stitchLevel(d: DeepZoomDescriptor, cap = 16384): number {
  const ml = maxLevel(d);
  for (let l = ml; l >= 0; l--) {
    const { w, h } = levelDimensions(d, l);
    if (Math.max(w, h) <= cap) return l;
  }
  return 0;
}

// ─── OpenSeadragon viewing ─────────────────────────────────────────────────────

/**
 * A custom OpenSeadragon tile source built straight from the descriptor — no
 * second descriptor fetch. `proxy` routes tiles through /api/tile (needed only
 * when the canvas must stay exportable; for plain viewing leave it false).
 */
export function osdTileSource(d: DeepZoomDescriptor, proxy = false) {
  return {
    width: d.width,
    height: d.height,
    tileSize: d.tileSize,
    tileOverlap: d.overlap,
    minLevel: 0,
    maxLevel: maxLevel(d),
    getTileUrl: (level: number, x: number, y: number) => {
      const u = tileUrl(d, level, x, y);
      return proxy ? `/api/tile?url=${encodeURIComponent(u)}` : u;
    },
  };
}

/** A small whole-image thumbnail URL (single-tile level), proxied for CORS. */
export function thumbUrl(d: DeepZoomDescriptor): string {
  const l = thumbLevel(d);
  return `/api/tile?url=${encodeURIComponent(tileUrl(d, l, 0, 0))}`;
}

// ─── Canvas stitching (download) ───────────────────────────────────────────────

export interface StitchOptions {
  /** Override the level; default = deepest level within `maxEdge`. */
  level?: number;
  /** Cap on the stitched long edge (browser canvas safety). Default 16384. */
  maxEdge?: number;
  /** JPEG quality 0–1 (ignored for PNG output). Default 0.95. */
  quality?: number;
  /** Max tiles in flight at once. Default 32 — stitching is latency-bound (many
   *  tiny requests), and HTTP/2 multiplexes these over one connection, so high
   *  concurrency directly cuts wall-time. Well within H2's ~100-stream limit. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface StitchResult {
  blob: Blob;
  width: number;
  height: number;
  level: number;
}

/**
 * Fetch a tile and decode it OFF the main thread via createImageBitmap (far
 * faster than <img>.onload, and keeps the UI responsive). `direct` loads straight
 * from the tile host's CDN (cross-origin, needs ACAO) — skipping our proxy hop;
 * otherwise it goes through same-origin /api/tile (which always sends ACAO).
 */
async function fetchBitmap(url: string, crossOrigin: boolean, signal?: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { signal, mode: crossOrigin ? 'cors' : 'same-origin', cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

async function loadTile(
  d: DeepZoomDescriptor,
  level: number,
  col: number,
  row: number,
  direct: boolean,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const raw = tileUrl(d, level, col, row);
  const proxied = `/api/tile?url=${encodeURIComponent(raw)}`;
  let tries = 0;
  for (;;) {
    try {
      return await fetchBitmap(direct ? raw : proxied, direct, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      // A direct (CDN) tile that fails — fall back to the proxy for this one.
      if (direct) {
        try { return await fetchBitmap(proxied, false, signal); } catch { /* retry below */ }
      }
      if (++tries >= 3) throw new Error(`tile ${level}/${col}_${row} failed`);
      await new Promise((r) => setTimeout(r, 250 * tries));
    }
  }
}

/** Can we read this host's tiles cross-origin (untainted)? If yes, we skip the
 *  proxy and pull straight from the CDN — the single biggest speed win. */
async function probeDirect(d: DeepZoomDescriptor, level: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const bmp = await fetchBitmap(tileUrl(d, level, 0, 0), true, signal);
    bmp.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Download every tile of the chosen level and composite them into one full-res
 * image. Off-thread decode, high concurrency (HTTP/2), direct-CDN fast path,
 * retrying, abortable, with progress callbacks.
 */
export async function stitchToBlob(d: DeepZoomDescriptor, opts: StitchOptions = {}): Promise<StitchResult> {
  const level = opts.level ?? stitchLevel(d, opts.maxEdge ?? 16384);
  const { w, h } = levelDimensions(d, level);
  const { cols, rows } = levelTiles(d, level);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: d.format === 'png' });
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const tasks: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tasks.push({ col: c, row: r });

  // One probe decides direct-CDN vs proxy for the whole batch.
  const direct = await probeDirect(d, level, opts.signal);

  const total = tasks.length;
  let done = 0;
  let next = 0;
  const CONCURRENCY = Math.min(opts.concurrency ?? 32, tasks.length);

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException('Stitch aborted', 'AbortError');
      const i = next++;
      if (i >= tasks.length) return;
      const { col, row } = tasks[i];
      const bmp = await loadTile(d, level, col, row, direct, opts.signal);
      // DZI tiles carry `overlap` extra px on interior edges; shifting the draw
      // origin left/up by overlap lands the content pixels exactly. Overlapping
      // regions overwrite identically, so the seam is invisible. Zoomify/IIIF
      // have overlap 0, so this is a no-op there.
      const dx = col * d.tileSize - (col > 0 ? d.overlap : 0);
      const dy = row * d.tileSize - (row > 0 ? d.overlap : 0);
      ctx.drawImage(bmp, dx, dy);
      bmp.close(); // free decoded memory immediately (thousands of tiles)
      done++;
      opts.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const type = d.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), type, opts.quality ?? 0.95),
  );
  return { blob, width: w, height: h, level };
}
