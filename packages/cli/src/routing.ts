/**
 * URL classification — ported from harpe/routing.py (pure parts). Decides how a
 * URL is handled: zoomable art, reference/encyclopedia page, video, or images.
 */

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
