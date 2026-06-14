/**
 * Resolution presets and format options for the DownloadMenu component.
 * Also provides screen-aware helpers and proxy URL builder.
 */

// ─── Presets ──────────────────────────────────────────────────────────────────

/** A named resolution preset. longEdge=null means "original, no resizing". */
export interface ResolutionPreset {
  label: string;
  longEdge: number | null;
}

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { label: 'Original', longEdge: null },
  { label: '4K  (3840)', longEdge: 3840 },
  { label: '1440p (2560)', longEdge: 2560 },
  { label: '1080p (1920)', longEdge: 1920 },
  { label: '720p (1280)', longEdge: 1280 },
  { label: 'Phone (1290)', longEdge: 1290 },
];

export interface FormatOption {
  label: string;
  fmt: string;
}

export const FORMATS: FormatOption[] = [
  { label: 'JPEG', fmt: 'jpeg' },
  { label: 'PNG · lossless', fmt: 'png' },
  { label: 'WebP', fmt: 'webp' },
];

// ─── Screen helpers ───────────────────────────────────────────────────────────

/**
 * Returns a preset representing the user's physical screen resolution,
 * or null if called during SSR or the resolution is already below Phone.
 */
export function screenPreset(): { label: string; longEdge: number } | null {
  if (typeof window === 'undefined') return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.screen.width * dpr);
  const h = Math.round(window.screen.height * dpr);
  const longEdge = Math.max(w, h);
  if (longEdge < 1) return null;
  return { label: `Fits your screen (${w}×${h})`, longEdge };
}

/**
 * Returns true if the image is large enough to be a crisp wallpaper at the
 * user's screen resolution (long edge of image ≥ long edge of screen in px).
 */
export function fitsScreen(imgW: number, imgH: number): boolean {
  if (typeof window === 'undefined') return false;
  const preset = screenPreset();
  if (!preset) return false;
  const imgLong = Math.max(imgW, imgH);
  return imgLong >= preset.longEdge;
}

// ─── URL builder ──────────────────────────────────────────────────────────────

/**
 * Builds a `/api/fetch?...` URL for the given image and conversion options.
 * When longEdge is null/undefined and fmt is omitted, returns the plain
 * passthrough proxy URL (no conversion params → streaming passthrough).
 */
export function buildFetchUrl(
  fullUrl: string,
  opts: { longEdge?: number | null; fmt?: string; q?: number },
): string {
  const p = new URLSearchParams({ url: fullUrl });
  if (opts.longEdge && opts.longEdge > 0) {
    p.set('w', String(opts.longEdge));
  }
  if (opts.fmt) {
    p.set('fmt', opts.fmt);
  }
  if (opts.q !== undefined) {
    p.set('q', String(opts.q));
  }
  return `/api/fetch?${p.toString()}`;
}
