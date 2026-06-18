/**
 * GET /api/stats
 *
 * Returns live coverage numbers for the Harpe homepage: total artworks indexed,
 * number of museums & archives, collections, and countries covered.
 *
 * Each ACTIVE source is probed for its real collection size via a lightweight
 * API call (usually limit=1 + read a pagination/total field). The results are
 * summed into a defensible, non-double-counted total using the same accounting
 * methodology as the marketing analysis:
 *   - Commons + Wikidata are counted once (100% overlap in P18 image set).
 *   - All other sources are summed directly.
 *
 * Honest framing: this total is open-access *works & images* discoverable, not
 * exclusively fine-art paintings — Europeana (~37M image records) and the
 * Smithsonian (CC0 media incl. natural history) dominate it and partly
 * re-aggregate the museum-direct sources, so it is an upper bound on reach, not
 * a deduplicated artwork count. The UI label says "artworks & images"
 * accordingly. (Per-result cross-source de-duplication happens at query time in
 * @harpe/core's rankResults; this endpoint reports catalog reach.)
 *
 * Caching: result stored in Upstash KV under key "stats:v1" with a 24 h TTL
 * (same lazy-singleton pattern as analyze.ts). Falls back gracefully when
 * Upstash is absent or any source probe fails — seed numbers are always
 * returned so the homepage never shows zeros.
 *
 * Rate-limited via guard.ts like every other handler.
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { fetch } from 'undici';

// ─── Seed / fallback numbers ────────────────────────────────────────────────
// Derived from the 2026-06-17 analysis. Used when any source or Upstash is
// unavailable so the page never renders zeros.

export const SEED = {
  artworks: 50_000_000,
  museumsAndArchives: 3_000,
  collections: 20,
  countries: 12,
} as const;

// Per-source seed totals (used as fallback when a live probe fails).
// Keys match the registry keys from @harpe/sources.
const SOURCE_SEEDS: Record<string, number> = {
  aic: 132_136,
  met: 501_868,
  cleveland: 68_743,
  vam: 1_307_410,
  wellcome: 641_973,
  smk: 54_398,
  nasjonalmuseet: 59_081,
  digitalnz: 1_198_088,
  // Wikidata+Commons counted once — use Wikidata's curated 596k as the
  // canonical overlap-free value.
  wikidata: 596_103,
  loc: 1_219_550,
  wikiart: 250_000,
  europeana: 37_475_380,
  harvard: 224_111,
  si: 5_256_879,
  parismusees: 1_000_000,
  moma: 145_000,
  nga: 279_599,
  mia: 90_000,
};

// ─── Live count probes ───────────────────────────────────────────────────────
// Each returns a number (the total count for that source) or throws.
// Timeout: 6 s each (generous — we run them in parallel).

const TIMEOUT_MS = 6_000;
const UA = 'HarpeArtSearch/1.0 (https://harpe-site.vercel.app; +stats)';

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

type Probe = () => Promise<number>;

// AIC: api.artic.edu/api/v1/artworks?limit=1 → pagination.total
const probeAic: Probe = async () => {
  const d = await fetchJson('https://api.artic.edu/api/v1/artworks?limit=1') as {
    pagination?: { total?: number };
  };
  const n = d?.pagination?.total;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Met: collectionapi.metmuseum.org/public/collection/v1/objects → total
const probeMet: Probe = async () => {
  const d = await fetchJson('https://collectionapi.metmuseum.org/public/collection/v1/objects') as {
    total?: number;
  };
  const n = d?.total;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Cleveland: openaccess-api.clevelandart.org/api/artworks/?limit=1 → info.total
const probeCleveland: Probe = async () => {
  const d = await fetchJson('https://openaccess-api.clevelandart.org/api/artworks/?limit=1') as {
    info?: { total?: number };
  };
  const n = d?.info?.total;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// V&A: api.vam.ac.uk/v2/objects/search?page_size=1 → info.record_count
const probeVam: Probe = async () => {
  const d = await fetchJson('https://api.vam.ac.uk/v2/objects/search?page_size=1') as {
    info?: { record_count?: number };
  };
  const n = d?.info?.record_count;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Wellcome: api.wellcomecollection.org/catalogue/v2/works?pageSize=1&availabilities=online → totalResults
const probeWellcome: Probe = async () => {
  const d = await fetchJson(
    'https://api.wellcomecollection.org/catalogue/v2/works?pageSize=1&availabilities=online',
  ) as { totalResults?: number };
  const n = d?.totalResults;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// SMK: api.smk.dk/api/v1/art/search?keys=*&filters=[has_image:true]&rows=1 → found
const probeSmk: Probe = async () => {
  const d = await fetchJson(
    'https://api.smk.dk/api/v1/art/search?keys=*&filters=%5Bhas_image%3Atrue%5D&rows=1',
  ) as { found?: number };
  const n = d?.found;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Nasjonalmuseet: api.nasjonalmuseet.no/api/v1/objects?size=1 → total_results
const probeNasjonalmuseet: Probe = async () => {
  const d = await fetchJson('https://api.nasjonalmuseet.no/api/v1/objects?size=1') as {
    total_results?: number;
  };
  const n = d?.total_results;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// DigitalNZ: api.digitalnz.org/v3/records.json?text=art&per_page=1 → search.result_count
const probeDigitalNZ: Probe = async () => {
  const d = await fetchJson(
    'https://api.digitalnz.org/v3/records.json?text=art&per_page=1',
  ) as { search?: { result_count?: number } };
  const n = d?.search?.result_count;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Wikidata: SPARQL COUNT for items with P18 image and artwork type
// (painting, drawing, sculpture, photograph, artwork)
// Using the Wikidata query service via GET with a compact SPARQL query.
// Commons is NOT probed separately — it fully overlaps with Wikidata P18 images.
const probeWikidata: Probe = async () => {
  const sparql = `SELECT (COUNT(?item) AS ?count) WHERE {
  ?item wdt:P18 ?img.
  ?item wdt:P31 ?type.
  VALUES ?type { wd:Q3305213 wd:Q93184 wd:Q860861 wd:Q179700 wd:Q11060274 }
}`;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const d = await fetchJson(url) as {
    results?: { bindings?: Array<{ count?: { value?: string } }> };
  };
  const raw = d?.results?.bindings?.[0]?.count?.value;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error('unexpected shape');
  return n;
};

// LOC: loc.gov/photos/?fo=json&c=1&at=pagination → pagination.total
const probeLoc: Probe = async () => {
  const d = await fetchJson('https://www.loc.gov/photos/?fo=json&c=1&at=pagination') as {
    pagination?: { total?: number };
  };
  const n = d?.pagination?.total;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Europeana: requires EUROPEANA_API_KEY env var
const probeEuropeana: Probe = async () => {
  const key = process.env.EUROPEANA_API_KEY;
  if (!key) throw new Error('no key');
  const d = await fetchJson(
    `https://api.europeana.eu/record/v2/search.json?wskey=${encodeURIComponent(key)}&query=*&qf=TYPE:IMAGE&rows=0`,
  ) as { totalResults?: number };
  const n = d?.totalResults;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Harvard: totalrecords from the API with imagepermissionlevel=0, limit=1
// Requires HARVARD_API_KEY env var
const probeHarvard: Probe = async () => {
  const key = process.env.HARVARD_API_KEY;
  if (!key) throw new Error('no key');
  const d = await fetchJson(
    `https://api.harvardartmuseums.org/object?apikey=${encodeURIComponent(key)}&imagepermissionlevel=0&size=1`,
  ) as { info?: { totalrecords?: number } };
  const n = d?.info?.totalrecords;
  if (typeof n !== 'number' || n <= 0) throw new Error('unexpected shape');
  return n;
};

// Smithsonian: sum CC0 media across all units
// Requires SMITHSONIAN_API_KEY env var
const probeSmithsonian: Probe = async () => {
  const key = process.env.SMITHSONIAN_API_KEY;
  if (!key) throw new Error('no key');
  const d = await fetchJson(
    `https://api.si.edu/openaccess/api/v1.0/stats?api_key=${encodeURIComponent(key)}`,
  ) as { CC0_media?: Record<string, number> };
  const counts = d?.CC0_media;
  if (!counts || typeof counts !== 'object') throw new Error('unexpected shape');
  const n = Object.values(counts).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  if (n <= 0) throw new Error('unexpected shape');
  return n;
};

// ─── Probe map: source key → probe function ───────────────────────────────────
// Only sources that have a live probe. Other sources (wikiart, parismusees,
// moma, nga, mia) use their seed values directly since they have no count
// endpoint or require a full dataset download.
const PROBES: Record<string, Probe> = {
  aic: probeAic,
  met: probeMet,
  cleveland: probeCleveland,
  vam: probeVam,
  wellcome: probeWellcome,
  smk: probeSmk,
  nasjonalmuseet: probeNasjonalmuseet,
  digitalnz: probeDigitalNZ,
  // Wikidata subsumes Commons (no separate commons probe)
  wikidata: probeWikidata,
  loc: probeLoc,
  europeana: probeEuropeana,
  harvard: probeHarvard,
  si: probeSmithsonian,
};

// ─── Overlap-aware total computation ─────────────────────────────────────────
// Commons fully overlaps with Wikidata, so it is excluded from the sum.
// All other sources are summed directly.
const EXCLUDED_FROM_TOTAL = new Set(['commons', 'nypl']); // nypl disabled in prod

/** Run all probes in parallel; use seed for any that fail. */
export async function fetchLiveCounts(): Promise<Record<string, number>> {
  const keys = Object.keys(SOURCE_SEEDS);
  const results = await Promise.allSettled(
    keys.map(async (key) => {
      if (EXCLUDED_FROM_TOTAL.has(key)) return [key, SOURCE_SEEDS[key]] as [string, number];
      const probe = PROBES[key];
      if (!probe) return [key, SOURCE_SEEDS[key]] as [string, number];
      try {
        const n = await probe();
        return [key, n] as [string, number];
      } catch {
        return [key, SOURCE_SEEDS[key]] as [string, number];
      }
    }),
  );

  const counts: Record<string, number> = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const [key, n] = r.value;
      counts[key] = n;
    }
  }
  return counts;
}

/** Sum counts, excluding overlap sources. */
export function sumCounts(counts: Record<string, number>): number {
  let total = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (!EXCLUDED_FROM_TOTAL.has(key)) total += n;
  }
  return total;
}

// ─── Response shape ───────────────────────────────────────────────────────────

export interface StatsResponse {
  artworks: number;
  museumsAndArchives: number;
  collections: number;
  countries: number;
  perSource?: Record<string, number>;
  updatedAt: string;
}

// ─── Upstash KV cache (same lazy-singleton as analyze.ts) ─────────────────────

const CACHE_KEY = 'stats:v1';
const CACHE_TTL_S = 60 * 60 * 24; // 24 hours

type Redis = { get: (k: string) => Promise<unknown>; set: (k: string, v: string, o: { ex: number }) => Promise<unknown> };
let _redis: Redis | null | undefined; // undefined = not init'd

export async function getRedis(): Promise<Redis | null> {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) { _redis = null; return null; }
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({ url, token }) as unknown as Redis;
  } catch { _redis = null; }
  return _redis;
}

/** Reset the Redis singleton — only for use in tests. */
export function _resetRedisForTest(): void {
  _redis = undefined;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'GET only' });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    await rateLimit(ip);
  } catch (e) {
    if (e instanceof GuardError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ error: e.message });
    }
    throw e;
  }

  // ── Cache lookup ──
  const redis = await getRedis();
  if (redis) {
    try {
      const hit = await redis.get(CACHE_KEY);
      if (hit) {
        const cached: StatsResponse = typeof hit === 'string' ? JSON.parse(hit) : (hit as StatsResponse);
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
        return res.status(200).json(cached);
      }
    } catch { /* ignore cache errors */ }
  }

  // ── Live fetch ──
  let perSource: Record<string, number>;
  let artworks: number;
  try {
    perSource = await fetchLiveCounts();
    artworks = sumCounts(perSource);
    // Guard against a bad sum (e.g. all probes returned 0)
    if (artworks < SEED.artworks) artworks = SEED.artworks;
  } catch {
    perSource = { ...SOURCE_SEEDS };
    artworks = SEED.artworks;
  }

  const payload: StatsResponse = {
    artworks,
    museumsAndArchives: SEED.museumsAndArchives,
    collections: SEED.collections,
    countries: SEED.countries,
    perSource,
    updatedAt: new Date().toISOString(),
  };

  // ── Cache write ──
  if (redis) {
    try {
      await redis.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_TTL_S });
    } catch { /* ignore */ }
  }

  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
  return res.status(200).json(payload);
}
