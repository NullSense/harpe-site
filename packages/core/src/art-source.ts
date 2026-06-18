export const SOURCE_KEYS = [
  'aic',
  'met',
  'cleveland',
  'commons',
  'wikiart',
  'vam',
  'wellcome',
  'smk',
  'nasjonalmuseet',
  'digitalnz',
  'wikidata',
  'europeana',
  'harvard',
  'si',
  'parismusees',
  'moma',
  'nga',
  'mia',
  'loc',
  'nypl',
] as const;

export type SourceKey = (typeof SOURCE_KEYS)[number];

const SOURCE_KEY_SET = new Set<SourceKey>(SOURCE_KEYS);

// A single downloadable file variant for a work. Sources often expose more than
// one (e.g. a high-res JPEG and a lossless TIFF original) so callers can show
// format/quality and let the user choose.
export interface Download {
  label: string;
  url: string;
  format: string;
  lossless: boolean;
}

export interface ArtItem {
  id: string;
  title: string;
  artist: string;
  dimensions: string;
  thumbUrl: string;
  previewUrl: string;
  fullUrl: string;
  width?: number;
  height?: number;
  format: string;
  lossless: boolean;
  downloads: Download[];
  source: SourceKey;
  isPublicDomain: boolean;
  // Enrichment fields for the union model beyond the basic display/download shape.
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
  /** Upstream institution/provider for aggregate or dump-backed sources. */
  provider?: string;
  /** Accession / inventory number from the holding institution. */
  accessionNumber?: string;
  /** Machine-readable license URI (CC0, CC-BY-SA, etc.) for downstream attribution. */
  licenseUrl?: string;
  /** Subject/keyword tags (e.g. from AIC subject_titles, Met tags, Wikidata depicts). */
  tags?: string[];
  /** Artwork type / object type (Painting, Photograph, Sculpture, Print, Drawing, …). */
  artworkType?: string;
}

/**
 * A museum/gallery source adapter. The fetch implementation is host-owned; the
 * normalized ArtItem contract is shared by all hosts.
 */
export interface SourceAdapter {
  /** Stable id, also the value each item carries as ArtItem.source. */
  key: SourceKey;
  /** Display name, used in chips and per-source warnings. */
  label: string;
  /** Query the source and return normalized, unified ArtItems. */
  fetch: (q: string) => Promise<ArtItem[]>;
  /** Env var that must be set for this source to run. Omit for keyless sources. */
  requiresEnv?: string;
  /** Any one of these env vars can enable the source. */
  requiresAnyEnv?: string[];
  /** Kept in the registry for documentation but not queried. */
  disabled?: boolean;
  /** Why it's disabled / any caveat. */
  note?: string;
}

/**
 * Validate that an item conforms to the unified ArtItem contract. Returns a list
 * of problems ([] = valid). Used by source test-suites and dev-time assertions.
 */
export function validateArtItem(it: ArtItem): string[] {
  const p: string[] = [];
  for (const k of ['id', 'title', 'source'] as const) {
    if (typeof it[k] !== 'string' || !it[k]) p.push(`${k} missing/empty`);
  }
  const urlish = (v: string) => /^https?:\/\//i.test(v) || v.startsWith('/');
  for (const k of ['thumbUrl', 'previewUrl', 'fullUrl'] as const) {
    const v = it[k];
    if (v && !urlish(v)) p.push(`${k} is not a URL: ${v.slice(0, 48)}`);
  }
  if (!(it.thumbUrl || it.previewUrl || it.fullUrl)) p.push('no image URL (thumb/preview/full all empty)');
  if (typeof it.isPublicDomain !== 'boolean') p.push('isPublicDomain not boolean');
  if (typeof it.lossless !== 'boolean') p.push('lossless not boolean');
  if (!Array.isArray(it.downloads)) p.push('downloads not an array');
  if (it.width !== undefined && typeof it.width !== 'number') p.push('width not a number');
  if (it.height !== undefined && typeof it.height !== 'number') p.push('height not a number');
  if (it.source && !SOURCE_KEY_SET.has(it.source)) p.push(`unknown source key: ${it.source}`);
  return p;
}
