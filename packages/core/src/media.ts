/**
 * Media format + filename helpers — pure, runtime-agnostic. Shared so the site,
 * the CLI and the extension classify formats and name files identically.
 * (Browser-only download helpers live in the site's own media module.)
 */

export interface DownloadVariant {
  label: string;
  url: string;
  format: string; // 'jpeg' | 'png' | 'tiff' | 'webp' | 'gif'
  lossless: boolean;
}

export const LOSSLESS_FORMATS = new Set(['png', 'tiff', 'gif', 'bmp']);

export function extFor(format: string): string {
  if (format === 'jpeg') return 'jpg';
  if (format === 'tiff') return 'tiff';
  return format || 'jpg';
}

export function fmtFromUrl(url: string): string {
  const m = url.toLowerCase().match(/\.(jpe?g|png|tiff?|webp|gif|bmp)(?:[?#]|$)/);
  if (!m) return 'jpeg';
  const ext = m[1];
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  return ext;
}

/** Filesystem-safe "Artist - Title.ext" (capped, illegal chars stripped). */
export function safeName(title: string, artist = '', ext = 'jpg'): string {
  const slug = `${artist ? artist + ' - ' : ''}${title}`
    .replace(/[/\\:*?"<>|]/g, '')
    .slice(0, 80)
    .trim();
  return `${slug || 'image'}.${ext}`;
}

export const isURL = (s: string) => /^https?:\/\//i.test(s.trim());
