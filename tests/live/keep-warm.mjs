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

/**
 * Parse + clamp an integer env value to [1, max], falling back to `def` for
 * missing/non-numeric input. Keeps a fat-fingered WARM_COUNT from firing
 * thousands of requests at the origin.
 * @returns {number}
 */
export function clampCount(raw, max, def) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

/**
 * Summarize warm results into a pass/fail by success ratio. A green run must
 * mean "the origin is actually warm", so we require a meaningful fraction to
 * succeed — not just one — and an empty set never passes.
 * @returns {{ok:number,total:number,ratio:number,pass:boolean}}
 */
export function summarizeWarm(results, threshold) {
  const total = results.length;
  const ok = results.filter((r) => r && r.ok).length;
  const ratio = total ? ok / total : 0;
  return { ok, total, ratio, pass: total > 0 && ratio >= threshold };
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
const COUNT = clampCount(process.env.WARM_COUNT, 100, 24);
const CONCURRENCY = clampCount(process.env.WARM_CONCURRENCY, 16, 4);
// Require this fraction of warms to succeed before the run is considered green
// (default 0.8). A lone success no longer masks a broad origin failure.
const THRESHOLD = Number.isFinite(Number(process.env.WARM_THRESHOLD)) ? Number(process.env.WARM_THRESHOLD) : 0.8;
// CDN stale-while-revalidate can serve a fast STALE response without the function
// ever running — so a "fast" warm wouldn't actually refresh KV/origin. A per-run
// cache-bust param forces the function to execute (and repopulate an expired KV key).
const CACHE_BUST = process.env.WARM_CACHE_BUST !== '0';
const RUN_TOKEN = String(Date.now());
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
  const bust = CACHE_BUST ? `&_w=${RUN_TOKEN}` : '';
  try {
    const data = await getJson(`${BASE}/api/art?q=${enc(q)}${bust}`, 40_000);
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
  console.log(`keep-warm: warming ${queries.length} queries against ${BASE} (concurrency ${CONCURRENCY}, threshold ${THRESHOLD}, cache-bust ${CACHE_BUST})`);
  const results = await warmAll(queries, CONCURRENCY);
  const okResults = results.filter((r) => r.ok);
  const slow = okResults.filter((r) => r.ms > 5_000).length;
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${String(r.ms).padStart(6)}ms  ${r.q}${r.ok ? ` (${r.items})` : ` — ${r.err}`}`);
  }
  const med = okResults.length ? okResults.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(okResults.length / 2)] : 0;
  const summary = summarizeWarm(results, THRESHOLD);
  console.log(`keep-warm: ${summary.ok}/${summary.total} ok (${(summary.ratio * 100).toFixed(0)}%) · median ${med}ms · ${slow} over 5s`);
  // Fail the run when the success ratio is below threshold — a broad origin
  // outage must be visible, not masked by a couple of lucky warms.
  if (!summary.pass) {
    console.error(`keep-warm: success ratio ${(summary.ratio * 100).toFixed(0)}% below threshold ${(THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }
}

// Run only when invoked directly (`node tests/live/keep-warm.mjs`), not on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
