/**
 * Reverse-image search — ported from harpe/reverse.py.
 *
 * Only SauceNAO is implemented here (JSON API, reliable + key-gated).
 * Ascii2D, IQDB, and Yandex from the Python version are intentionally deferred:
 * they have no stable keyless JSON API and HTML scraping is fragile.
 *
 * Returns TSV rows "engine\tsimilarity\ttitle\tsourceUrl\tthumb", sorted by
 * similarity descending, deduped by query-stripped sourceUrl.
 *
 * Reference for request/response shape: src/lib/server/handlers/sauce.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Domains that host the ORIGINAL (usually highest-resolution) copy of a work.
// Used for priority sorting — same list as the Python version.
const ORIGINAL_SOURCES = [
  'pixiv.net', 'danbooru.donmai.us', 'gelbooru.com', 'yande.re', 'konachan',
  'deviantart.com', 'artstation.com', 'behance.net', 'tumblr.com',
  'twitter.com', 'x.com', 'flickr.com', 'artsy.net', 'wikiart.org',
  'wikimedia.org', 'wikipedia.org', 'metmuseum.org', 'artic.edu',
  'clevelandart.org', 'rijksmuseum.nl', '.museum',
] as const;

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function saucenaoKey(): string {
  // Check env first, then legacy grab path, then harpe path.
  const envKey = process.env.SAUCENAO_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  for (const rel of ['.config/grab/saucenao.key', '.config/harpe/saucenao.key']) {
    try {
      const text = readFileSync(join(homedir(), rel), 'utf8').trim();
      if (text) return text;
    } catch {
      // file not present — try next
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// SauceNAO API types (mirrors sauce.ts response shape)
// ---------------------------------------------------------------------------

interface SauceNAOResponse {
  header?: { status?: number; message?: string };
  results?: Array<{
    header?: { similarity?: unknown; thumbnail?: unknown; index_name?: unknown };
    data?: {
      ext_urls?: unknown;
      title?: unknown;
      source?: unknown;
      member_name?: unknown;
      creator?: unknown;
      author_name?: unknown;
    };
  }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reverse-image search via SauceNAO.
 *
 * @param imgUrl - Public image URL to look up.
 * @returns TSV rows "engine\tsimilarity\ttitle\tsourceUrl\tthumb", best first.
 *          Returns [] if no API key is configured or on error.
 */
export async function reverseSearch(imgUrl: string): Promise<string[]> {
  const key = saucenaoKey();
  if (!key) return [];

  const apiUrl =
    `https://saucenao.com/search.php?output_type=2&numres=8&db=999` +
    `&api_key=${encodeURIComponent(key)}&url=${encodeURIComponent(imgUrl)}`;

  let json: SauceNAOResponse;
  try {
    const res = await fetch(apiUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    json = (await res.json()) as SauceNAOResponse;
  } catch {
    return [];
  }

  // Positive status = account/limit problem (daily quota hit, etc.)
  if ((json.header?.status ?? 0) > 0) return [];

  // Collect rows: (priority, -similarity, engine, simStr, title, url, thumb)
  type Row = [number, number, string, string, string, string, string];
  const rows: Row[] = [];

  for (const item of json.results ?? []) {
    const rawUrls = Array.isArray(item.data?.ext_urls)
      ? (item.data!.ext_urls as unknown[]).map((u) => (typeof u === 'string' ? u : '')).filter((u) => /^https?:/i.test(u))
      : [];
    if (rawUrls.length === 0) continue;

    const sourceLink = rawUrls[0];
    const simRaw = typeof item.header?.similarity === 'number'
      ? item.header.similarity
      : parseFloat(String(item.header?.similarity ?? ''));
    const simNum = Number.isFinite(simRaw) ? simRaw : -1;
    const simStr = simNum >= 0 ? `${Math.round(simNum)}%` : '~';

    // title falls back to index_name when data.title is absent or empty (|| not ??)
    const strOrEmpty = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    const rawTitle = strOrEmpty(item.data?.title) || strOrEmpty(item.header?.index_name);
    const title = rawTitle.replace(/\t/g, ' ').replace(/\n/g, ' ').trim().slice(0, 70);

    const thumb = typeof item.header?.thumbnail === 'string'
      ? item.header.thumbnail.replace(/\t/g, ' ').replace(/\n/g, ' ').trim()
      : '';

    let host = '';
    try { host = new URL(sourceLink).hostname.toLowerCase(); } catch { /* ignore */ }
    const priority = ORIGINAL_SOURCES.some((s) => host.includes(s)) ? 0 : 1;

    rows.push([priority, -simNum, 'SauceNAO', simStr, title, sourceLink, thumb]);
  }

  // Dedup by query-stripped sourceUrl — keep best (lowest priority, highest sim)
  const best = new Map<string, Row>();
  for (const row of rows) {
    const key2 = row[5].split('?')[0];
    const existing = best.get(key2);
    if (!existing || row[0] < existing[0] || (row[0] === existing[0] && row[1] < existing[1])) {
      best.set(key2, row);
    }
  }

  // Sort: original-source first, then similarity descending
  const sorted = [...best.values()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0]; // priority
    return a[1] - b[1];                      // -similarity (lower = higher sim)
  });

  return sorted.map(([, , engine, simStr, title, url, thumb]) =>
    `${engine}\t${simStr}\t${title}\t${url}\t${thumb}`,
  );
}
