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
  /** Art-historical movement or period (e.g. Impressionism, Baroque, Dutch Golden Age). */
  style?: string;
  /** Inscriptions, signatures, or marks on the work. */
  inscriptions?: string;
  /** Wikidata QID of the artwork itself (e.g. "Q1144558"), when known — from the
   *  wikidata source, or resolved from a Commons file's Structured Data (P6243
   *  "digital representation of"). Language-independent, so it folds the same
   *  painting across Commons (any language) + Wikidata into one card in dedupe(). */
  wikidataId?: string;
  /** When this item is the merge of several sources (set by dedupe()), the
   *  per-source catalogue records that were collapsed — so the AI analysis can
   *  still draw on EVERY source's facts/descriptions even after de-duplication. */
  variants?: SourceVariant[];
}

/** A single source's catalogue record, retained on a merged ArtItem.variants. */
export interface SourceVariant {
  source: string;
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
  accessionNumber?: string;
  artworkType?: string;
  style?: string;
  tags?: string[];
  inscriptions?: string;
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
  /** Query the source and return normalized, unified ArtItems.
   *  The optional AbortSignal is supplied by the resilience layer's timeout
   *  policy; adapters should pass it to fetch() and fall back to their own
   *  deadline when it's absent (direct/CLI calls). */
  fetch: (q: string, signal?: AbortSignal) => Promise<ArtItem[]>;
  /** Served from the dump-backed HF index (one shared, retried, breakered
   *  /search call) rather than a live API — so the per-source live breaker/
   *  timeout is skipped for it. Set by the registry's dump() helper. */
  dumpBacked?: boolean;
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
  // Optional enrichment fields — type-check only when present.
  for (const k of ['accessionNumber', 'licenseUrl', 'artworkType', 'style', 'inscriptions'] as const) {
    if (it[k] !== undefined && typeof it[k] !== 'string') p.push(`${k} not a string`);
  }
  if (it.tags !== undefined && !Array.isArray(it.tags)) p.push('tags not an array');
  if (Array.isArray(it.tags) && it.tags.some((t) => typeof t !== 'string')) p.push('tags contains non-string element');
  return p;
}
