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

// ─── Media-kind classification (ported from harpe/extract.py) ───────────────────

export const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff', '.tif', '.bmp'];
export const VIDEO_EXT = ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ts'];
export const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.wav', '.flac'];
/** Every extension recognised as a real media file (so a .mp4 keeps its suffix). */
export const MEDIA_EXT = [...IMG_EXT, ...VIDEO_EXT, ...AUDIO_EXT];

const CT_EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/tiff': '.tiff', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/x-matroska': '.mkv', 'video/mp2t': '.ts',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'audio/opus': '.opus', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac',
};

/** Canonical extension for a Content-Type value, or null if unknown. */
export function extFromContentType(ct?: string | null): string | null {
  if (!ct) return null;
  return CT_EXT[ct.split(';')[0].trim().toLowerCase()] ?? null;
}

export type MediaKind = 'image' | 'video' | 'audio';

/** Classify a file extension (with leading dot) as video / audio / image. */
export function kindForExt(ext: string): MediaKind {
  const e = ext.toLowerCase();
  if (VIDEO_EXT.includes(e)) return 'video';
  if (AUDIO_EXT.includes(e)) return 'audio';
  return 'image';
}

/** Filename for a URL: last path segment, sanitised, with a media extension. */
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
