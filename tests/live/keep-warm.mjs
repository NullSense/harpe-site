/**
 * Keep-warm pinger for Harpe search.
 *
 * Cold search latency comes entirely from the shared HF /filter call: when its
 * per-dataset index is cold AND the result isn't in Upstash KV (6h TTL) / the CDN,
 * a query pays the full cold-index wait. This script pre-warms the most popular
 * queries so real users land on a warm KV/CDN result instead of eating that cost.
 *
 * It pulls the live fame-ranked autocomplete pool from /api/suggest, picks the
 * top-N, and hits /api/art?q=… for each (the batch path writes COMPLETE results to
 * KV). Run on a schedule under the 6h KV TTL so a warm ping — not a user — is what
 * repopulates an expired key.
 *
 * Dependency-free (Node 22 global fetch). Run: `pnpm run keep-warm`
 *   WARM_BASE   override the site origin (default https://harpe-site.vercel.app)
 *   WARM_COUNT  how many top queries to warm (default 24)
 *   WARM_CONCURRENCY  parallel warm requests (default 4)
 */

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Choose which queries to warm from a /api/suggest payload.
 * Accepts either `{ suggestions: [...] }` or a bare array. Entries are already
 * fame-ranked; we keep that order, prefer `query` (fall back to `label`), drop
 * empties and <3-char noise (the entity resolver ignores those anyway), dedupe
 * case-insensitively, and take the first `n`.
 * @returns {string[]}
 */
export function pickWarmQueries(payload, n) {
  const rows = Array.isArray(payload) ? payload : (payload && payload.suggestions) || [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const q = String((row && (row.query || row.label)) || '').trim();
    if (q.length < 3) continue;
    const key = norm(q);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= n) break;
  }
  return out;
}

// Curated fallback so warming works even when data/suggest.json isn't published
// yet (the KG pool ships out-of-band of the code). Mirrors discover.ts's own
// "static list is the offline fallback" philosophy — famous, high-traffic queries.
const FALLBACK_QUERIES = [
  'Vincent van Gogh', 'Claude Monet', 'Rembrandt van Rijn', 'Johannes Vermeer',
  'Katsushika Hokusai', 'Gustav Klimt', 'Frida Kahlo', 'Edvard Munch',
  'Leonardo da Vinci', 'Pablo Picasso', 'Georgia O’Keeffe', 'Hilma af Klint',
  'Impressionism', 'Ukiyo-e', 'Baroque', 'Surrealism', 'Art Nouveau',
  'the great wave', 'water lilies', 'starry night sky', 'still life with flowers',
  'cats in art', 'old maps', 'the scream',
];

const BASE = (process.env.WARM_BASE || 'https://harpe-site.vercel.app').replace(/\/$/, '');
const COUNT = Number(process.env.WARM_COUNT) || 24;
const CONCURRENCY = Number(process.env.WARM_CONCURRENCY) || 4;
const enc = encodeURIComponent;

async function getJson(url, timeout = 30_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json', 'User-Agent': 'HarpeKeepWarm/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function warmOne(q) {
  const t0 = Date.now();
  try {
    const data = await getJson(`${BASE}/api/art?q=${enc(q)}`, 40_000);
    const n = Array.isArray(data.items) ? data.items.length : 0;
    return { q, ok: true, ms: Date.now() - t0, items: n };
  } catch (e) {
    return { q, ok: false, ms: Date.now() - t0, err: (e && e.message) || String(e) };
  }
}

/** Run warmOne over `queries` with bounded concurrency. */
async function warmAll(queries, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, queries.length) }, async () => {
    while (i < queries.length) {
      const q = queries[i++];
      results.push(await warmOne(q));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  // Prefer the live fame-ranked pool; top up from the curated fallback so we still
  // warm a full batch when suggest.json is empty/unreachable. Dedupe + cap is in
  // pickWarmQueries, so suggest entries take priority and fallback fills the rest.
  let suggestRows = [];
  try {
    const data = await getJson(`${BASE}/api/suggest`);
    suggestRows = Array.isArray(data) ? data : (data && data.suggestions) || [];
  } catch (e) {
    console.error(`keep-warm: /api/suggest unavailable, using fallback — ${(e && e.message) || e}`);
  }
  const merged = [...suggestRows, ...FALLBACK_QUERIES.map((q) => ({ query: q }))];
  const queries = pickWarmQueries(merged, COUNT);
  if (queries.length === 0) {
    console.error('keep-warm: no queries to warm');
    process.exit(1);
  }
  console.log(`keep-warm: warming ${queries.length} queries against ${BASE} (concurrency ${CONCURRENCY})`);
  const results = await warmAll(queries, CONCURRENCY);
  const ok = results.filter((r) => r.ok);
  const slow = ok.filter((r) => r.ms > 5_000).length;
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${String(r.ms).padStart(6)}ms  ${r.q}${r.ok ? ` (${r.items})` : ` — ${r.err}`}`);
  }
  const med = ok.length ? ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : 0;
  console.log(`keep-warm: ${ok.length}/${results.length} ok · median ${med}ms · ${slow} over 5s`);
  // Non-zero only if EVERY warm failed — a few slow/failed sources shouldn't fail CI.
  if (ok.length === 0) process.exit(1);
}

// Run only when invoked directly (`node tests/live/keep-warm.mjs`), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
