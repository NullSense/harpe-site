/**
 * Site media helpers — browser-only download/preview behaviour. The pure
 * format/filename helpers (extFor, fmtFromUrl, LOSSLESS_FORMATS, safeName,
 * isURL, DownloadVariant) now live in @harpe/core and are re-exported here so
 * existing site imports keep working.
 */
export { LOSSLESS_FORMATS, extFor, fmtFromUrl, safeName, isURL } from '@harpe/core';
export type { DownloadVariant } from '@harpe/core';

/** Build a same-origin proxy URL (forces attachment + bypasses CORS). */
function proxyUrl(url: string, referer?: string): string {
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
