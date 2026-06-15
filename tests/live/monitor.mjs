/**
 * Live synthetic monitor for Harpe — hits the REAL deployed endpoints and the
 * REAL upstream sources, so we learn the moment something breaks in the wild
 * (a museum changes its schema, hotlink rules, IIIF host, etc.).
 *
 * Dependency-free (Node 22 global fetch). Run: `npm run monitor`
 *   MONITOR_BASE   override the site origin (default https://harpe-site.vercel.app)
 * Writes monitor-results.json (consumed by the Monitor workflow to file issues)
 * and exits non-zero if any CRITICAL check fails.
 *
 * NOTE: X / Instagram / 1800+ video sites are the Harpe CLI's domain
 * (yt-dlp / gallery-dl), not this site — their live tests live in the harpe repo.
 */
import { writeFile } from 'node:fs/promises';

const BASE = (process.env.MONITOR_BASE || 'https://harpe-site.vercel.app').replace(/\/$/, '');
const enc = encodeURIComponent;

const results = [];
async function check(name, critical, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, critical, ok: true, ms: Date.now() - t0, note: note || '' });
  } catch (e) {
    results.push({ name, critical, ok: false, ms: Date.now() - t0, err: (e && e.message) || String(e) });
  }
}

async function get(url, { timeout = 20_000, accept = '*/*' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, { signal: ac.signal, headers: { Accept: accept, 'User-Agent': 'HarpeMonitor/1.0' } });
  } finally { clearTimeout(timer); }
}
async function getJson(url, opts) {
  const r = await get(url, { ...opts, accept: 'application/json' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Stable fixtures.
const DUOMO_DZI = 'https://openseadragon.github.io/example-images/duomo/duomo.dzi';
const DUOMO_TILE = 'https://openseadragon.github.io/example-images/duomo/duomo_files/12/0_0.jpg';

// Discover a live AIC image id so the IIIF/tile checks never depend on a single
// artwork that could be deaccessioned.
let aicImageId = null;
await check('source:AIC search (schema: data[].image_id)', true, async () => {
  const j = await getJson('https://api.artic.edu/api/v1/artworks/search?q=monet&fields=id,image_id&limit=5');
  aicImageId = (j.data || []).map((d) => d.image_id).find(Boolean);
  if (!aicImageId) throw new Error('no image_id in AIC response');
  return aicImageId;
});
const aicInfo = aicImageId && `https://www.artic.edu/iiif/2/${aicImageId}/info.json`;
const aicTile = aicImageId && `https://www.artic.edu/iiif/2/${aicImageId}/0,0,512,512/256,/0/default.jpg`;

// ── Our endpoints (the contract users actually hit) ──────────────────────────
await check('site:/api/art search returns items', true, async () => {
  const j = await getJson(`${BASE}/api/art?q=monet%20water%20lilies`);
  if (!(j.items && j.items.length > 0)) throw new Error('no items');
  return `${j.items.length} items`;
});

await check('site:/api/art-stream SSE yields a batch', true, async () => {
  const r = await get(`${BASE}/api/art-stream?q=monet`, { accept: 'text/event-stream' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!/data:\s*\{/.test(text)) throw new Error('no SSE data frames');
});

await check('site:/api/iiif proxy (AIC info.json)', true, async () => {
  if (!aicInfo) throw new Error('skipped: no AIC id');
  const j = await getJson(`${BASE}/api/iiif?url=${enc(aicInfo)}`);
  if (!j.width || !j.height) throw new Error('info.json missing dimensions');
  return `${j.width}x${j.height}`;
});

await check('site:/api/tile proxy serves AIC tiles (referer-default → no 403)', true, async () => {
  if (!aicTile) throw new Error('skipped: no AIC id');
  const r = await get(`${BASE}/api/tile?url=${enc(aicTile)}`, { accept: 'image/*' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || '');
  if (!ct.startsWith('image/')) throw new Error(`not an image: ${ct}`);
});

await check('site:/api/deepzoom detects a DZI descriptor', true, async () => {
  const j = await getJson(`${BASE}/api/deepzoom?url=${enc(DUOMO_DZI)}`);
  if (!j.ok || !j.descriptor || j.descriptor.protocol !== 'dzi') throw new Error('no DZI descriptor');
  return `${j.descriptor.width}x${j.descriptor.height}`;
});

await check('site:/api/x resolves tweet media (public syndication)', false, async () => {
  // Example post; non-critical (tweets can be deleted — reports, doesn't page).
  const j = await getJson(`${BASE}/api/x?id=2034694139066077325`);
  if (!Array.isArray(j.media) || j.media.length === 0) throw new Error('no media');
  const v = j.media.find((m) => m.type === 'video');
  if (v && !v.best) throw new Error('video without mp4');
  return `${j.media.length} media`;
});

await check('site:/api/grab reachable (501 until COBALT_API_URL is set)', false, async () => {
  const r = await get(`${BASE}/api/grab?url=${enc('https://youtube.com/watch?v=dQw4w9WgXcQ')}`);
  // 501 = cobalt not configured (expected default); 200/422/404 = configured + working.
  if (![200, 422, 404, 501].includes(r.status)) throw new Error(`unexpected ${r.status}`);
  return r.status === 501 ? 'cobalt not configured' : `status ${r.status}`;
});

await check('site:/api/scan extracts images from a page', false, async () => {
  const j = await getJson(`${BASE}/api/scan?url=${enc('https://en.wikipedia.org/wiki/The_Death_of_Socrates')}`);
  if (!(j.images && j.images.length > 0)) throw new Error('no images extracted');
  return `${j.images.length} images`;
});

// ── Deep-zoom / stitching upstream reachability ──────────────────────────────
await check('deepzoom:DZI tiles reachable (duomo)', true, async () => {
  const r = await get(DUOMO_TILE, { accept: 'image/*' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
});
await check('deepzoom:AIC IIIF tiles reachable directly', false, async () => {
  if (!aicTile) throw new Error('skipped: no AIC id');
  // Direct (no referer) is EXPECTED to 403 on AIC — that's why we proxy. This
  // check documents the behaviour; it passes whether 200 or 403, fails on 5xx.
  const r = await get(aicTile, { accept: 'image/*' });
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  return `direct status ${r.status} (proxy handles 403)`;
});

// ── Upstream source contracts (catch schema drift like the Nasjonalmuseet bug) ─
await check('source:Met (schema: objectIDs)', false, async () => {
  const j = await getJson('https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=monet');
  if (!Array.isArray(j.objectIDs) || j.objectIDs.length === 0) throw new Error('no objectIDs');
});
await check('source:Cleveland (schema: data[].images)', false, async () => {
  const j = await getJson('https://openaccess-api.clevelandart.org/api/artworks?q=monet&has_image=1&limit=1');
  if (!j.data?.[0]) throw new Error('no data');
});
await check('source:Nasjonalmuseet (schema: data[].uuid + multimedia)', true, async () => {
  const j = await getJson('https://api.nasjonalmuseet.no/api/v1/objects/text-search?q=munch');
  const it = (j.data || [])[0];
  if (!it?.uuid || !Array.isArray(it.multimedia)) throw new Error('schema drift — uuid/multimedia missing');
});

// Informational marker — set expectations honestly.
results.push({ name: 'note:X/Instagram/video = Harpe CLI (yt-dlp/gallery-dl), not this site', critical: false, ok: true, note: 'tested in the harpe repo' });

// ── Report ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const criticalFailed = failed.filter((r) => r.critical);
for (const r of results) {
  const tag = r.ok ? 'ok  ' : r.critical ? 'FAIL' : 'warn';
  console.log(`  ${tag}  ${r.name}${r.note ? `  (${r.note})` : ''}${r.err ? `  → ${r.err}` : ''}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} ok · ${criticalFailed.length} critical failure(s)`);
await writeFile('monitor-results.json', JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
process.exit(criticalFailed.length ? 1 : 0);
