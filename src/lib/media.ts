/**
 * Shared media helpers — used by every result view so download/format/preview
 * behaviour is identical across the whole app (no per-tab divergence).
 */

export interface DownloadVariant {
  label: string;
  url: string;
  format: string;    // 'jpeg' | 'png' | 'tiff' | 'webp' | 'gif'
  lossless: boolean;
}

/** A slide for the shared lightbox (shape consumed by yet-another-react-lightbox). */
export interface LightboxSlide {
  src: string;
  title?: string;
  description?: string;
  downloadUrl?: string;
  downloadFilename?: string;
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

/** Build a same-origin proxy URL (forces attachment + bypasses CORS). */
export function proxyUrl(url: string, referer?: string): string {
  const p = new URLSearchParams({ url });
  if (referer) p.set('referer', referer);
  return `/api/fetch?${p.toString()}`;
}

/**
 * Display-safe image src. Insecure `http://` URLs are blocked by the browser as
 * mixed content on our HTTPS page (and auto-upgrade often fails on bad certs), so
 * route those through our same-origin HTTPS proxy. `https://` URLs pass through
 * untouched (no extra proxy cost for the common case).
 */
export function displaySrc(url: string, referer?: string): string {
  if (!url) return url;
  return url.startsWith('http://') ? proxyUrl(url, referer) : url;
}

/** Fetch an image through the proxy and trigger a browser download. */
export async function downloadViaProxy(
  url: string,
  filename: string,
  referer?: string,
): Promise<void> {
  const res = await fetch(proxyUrl(url, referer));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
}

export function safeName(title: string, artist = '', ext = 'jpg'): string {
  const slug = `${artist ? artist + ' - ' : ''}${title}`
    .replace(/[/\\:*?"<>|]/g, '')
    .slice(0, 80)
    .trim();
  return `${slug || 'image'}.${ext}`;
}

export const isURL = (s: string) => /^https?:\/\//i.test(s.trim());
