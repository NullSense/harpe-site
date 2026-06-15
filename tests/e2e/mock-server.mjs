/**
 * Dependency-free mock API + static server for Harpe E2E.
 *
 * Serves the production build (dist/) and canned, deterministic /api responses so
 * the browser tests exercise the REAL app without touching live museum APIs:
 *   - /api/art-stream : SSE with one IIIF deep-zoom item + one plain image item
 *   - /api/iiif       : a synthetic IIIF info.json (drives OpenSeadragon)
 *   - /api/deepzoom   : a small DZI descriptor (drives the stitch path)
 *   - /api/tile,/fetch: a real gray JPEG (via sharp, already a dependency) so the
 *                       OSD canvas + the stitch canvas actually render pixels
 *   - /api/analyze    : a canned educational analysis
 *
 * No new dependencies — http/fs are built-in, sharp already ships with the app.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';

const PORT = Number(process.argv[2] || 4310);
const DIST = new URL('../../dist/', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

// One reusable gray JPEG for every tile/image request (non-black → canvas is
// provably non-blank; same-origin via the proxy → canvas stays un-tainted).
let TILE;
async function tile() {
  if (!TILE) TILE = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 120, g: 120, b: 120 } } }).jpeg().toBuffer();
  return TILE;
}

const IIIF_BASE = 'http://museum.test/iiif/2/demo';
const ITEMS = [
  {
    id: 'iiif:demo', title: 'Deep Zoom Demo', artist: 'Test Painter',
    thumbUrl: `${IIIF_BASE}/full/843,/0/default.jpg`,
    previewUrl: `${IIIF_BASE}/full/1200,/0/default.jpg`,
    fullUrl: `${IIIF_BASE}/full/full/0/default.jpg`,
    format: 'jpeg', lossless: false,
    downloads: [{ label: 'JPEG', url: `${IIIF_BASE}/full/full/0/default.jpg`, format: 'jpeg', lossless: false }],
    source: 'aic', isPublicDomain: true, date: '1787', medium: 'Oil on canvas',
    description: 'A demo painting used by the end-to-end tests.',
  },
  {
    id: 'img:demo', title: 'Plain Image Demo', artist: 'Test Painter',
    thumbUrl: 'http://museum.test/plain/thumb.jpg', previewUrl: 'http://museum.test/plain/preview.jpg',
    fullUrl: 'http://museum.test/plain/full.jpg', format: 'jpeg', lossless: false,
    downloads: [{ label: 'JPEG', url: 'http://museum.test/plain/full.jpg', format: 'jpeg', lossless: false }],
    source: 'met', isPublicDomain: true, date: '1850', medium: 'Watercolour',
  },
];

const IIIF_INFO = {
  '@context': 'http://iiif.io/api/image/2/context.json',
  '@id': IIIF_BASE, protocol: 'http://iiif.io/api/image',
  width: 2048, height: 1536,
  tiles: [{ width: 512, scaleFactors: [1, 2, 4] }],
  profile: ['http://iiif.io/api/image/2/level2.json'],
};

const DZI_DESCRIPTOR = {
  protocol: 'dzi', width: 1024, height: 768, tileSize: 512, overlap: 0,
  format: 'jpg', base: 'http://museum.test/dzi/x', sourceUrl: 'http://museum.test/dzi/x.dzi',
};

const ANALYSIS = `The Subject: A demonstration painting used to exercise the analysis dialog.

Context: Produced for the Harpe end-to-end test suite, in the Neoclassical idiom.

How to Look: The eye is led from left to right across the composition.

Meaning: It exists to prove the analysis renders above the viewer.

Facts: 1787 · Oil on canvas · Test Collection
Learn more: https://en.wikipedia.org/wiki/Test`;

const json = (res, obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/art-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ source: 'aic', items: ITEMS })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, analyzeEnabled: true })}\n\n`);
      return res.end();
    }
    if (u.pathname === '/api/iiif') return json(res, IIIF_INFO);
    if (u.pathname === '/api/deepzoom') return json(res, { ok: true, descriptor: DZI_DESCRIPTOR });
    if (u.pathname === '/api/analyze') return json(res, { analysis: ANALYSIS, contributors: ['aic', 'met'], cached: false, wikipedia: { title: 'Test', url: 'https://en.wikipedia.org/wiki/Test' } });
    if (u.pathname === '/api/scan') return json(res, { images: [], deepzoom: null, sauceEnabled: false });
    if (u.pathname === '/api/tile' || u.pathname === '/api/fetch') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
      return res.end(await tile());
    }
    if (u.pathname.startsWith('/api/')) return json(res, {});

    // static dist
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    let body;
    try { body = await readFile(join(DIST, p)); }
    catch { body = await readFile(join(DIST, 'index.html')); p = '/index.html'; }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(502); res.end(String(e));
  }
});

server.listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`));
