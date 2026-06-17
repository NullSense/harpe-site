/**
 * Vercel Edge Middleware — dynamic link previews for a static SPA.
 *
 * Social crawlers (Twitter/Slack/Discord/Facebook/Signal/…) don't run JS, so a
 * shared `/?q=…&v=<id>` link would only ever show the static default card. This
 * intercepts crawler requests and returns a tiny HTML doc with PER-ITEM Open
 * Graph tags, then redirects real browsers to the SPA.
 *
 * Preview image: ALWAYS routed through our /api/fetch resize proxy, capped to a
 * ~1200px JPEG. This is the key to reliable previews:
 *   • huge paintings (multi-MB / TIFF originals) otherwise blow past crawler
 *     limits — Signal hard-caps the preview image at 1 MiB and bails silently;
 *   • museum CDNs hotlink-block third-party fetchers (403) — the proxy fetches
 *     server-side with a browser UA and re-serves same-origin;
 *   • output is a small, valid, CDN-cached (s-maxage=1d) image/jpeg.
 * A default site image is used when an item has none, so the card always renders.
 *
 * Item data comes from the share URL when present (`t`, `img`, `d` embedded by
 * the Share button — zero refetch), else resolved by re-running the search once.
 */

export const config = { matcher: '/' };

// Signal masquerades as `WhatsApp/2`; we also match the common preview/
// link-expander tokens so newer apps (Mastodon, Bluesky, iframely…) get a card.
const BOT =
  /(facebookexternalhit|facebookcatalog|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegrambot|linkedinbot|embedly|iframely|quora link preview|pinterest|redditbot|applebot|bingbot|googlebot|google-inspectiontool|skypeuripreview|vkshare|mastodon|bluesky|bot\b|preview|crawler|spider)/i;

const OG_W = 1200;
const DEFAULT_IMG = '/logo-bronze.png';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Absolute, size-capped, same-origin JPEG for any candidate image URL. */
export function previewImage(origin: string, raw: string): { url: string; type: string } {
  if (!raw) return { url: `${origin}${DEFAULT_IMG}`, type: 'image/png' };
  let src = raw;
  try {
    const abs = /^https?:/i.test(raw) ? new URL(raw) : new URL(raw, origin);
    if (abs.origin === origin) {
      if (abs.pathname === '/api/fetch' && abs.searchParams.get('url')) {
        src = abs.searchParams.get('url')!; // unwrap so we re-cap at OG_W
      } else {
        return { url: abs.href, type: '' }; // some other same-origin asset — leave it
      }
    } else {
      src = abs.href;
    }
  } catch {
    return { url: `${origin}${DEFAULT_IMG}`, type: 'image/png' };
  }
  return {
    url: `${origin}/api/fetch?url=${encodeURIComponent(src)}&w=${OG_W}&fmt=jpeg&q=80`,
    type: 'image/jpeg',
  };
}

export default async function middleware(req: Request): Promise<Response | undefined> {
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  const ua = req.headers.get('user-agent') || '';
  if (!q || !BOT.test(ua)) return; // real users → serve the SPA as normal

  const v = url.searchParams.get('v') || '';
  let title = url.searchParams.get('t') || '';
  let img = url.searchParams.get('img') || '';
  let desc = url.searchParams.get('d') || '';

  // No embedded preview data (e.g. a plain address-bar copy) → resolve the item
  // server-side. We hit /api/preview (Node runtime, reuses gatherSources) via the
  // DEPLOYMENT URL, not the public alias — edge can't reliably fetch its own
  // alias, but the per-deployment host works. Non-fatal: any failure → defaults.
  if ((!title || !img) && !/^https?:/i.test(q)) {
    const base =
      typeof process !== 'undefined' && process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : url.origin;
    try {
      const r = await fetch(
        `${base}/api/preview?q=${encodeURIComponent(q)}&v=${encodeURIComponent(v)}`,
        { signal: AbortSignal.timeout(6000) },
      );
      const j = (await r.json()) as { title?: string; img?: string; desc?: string };
      title = title || j.title || '';
      img = img || j.img || '';
      desc = desc || j.desc || '';
    } catch { /* fall back to defaults */ }
  }

  title = title || `${q} — Harpe`;
  desc = desc || `Search "${q}" across 15 open museum collections — free public-domain art & image search.`;
  const canonical = `${url.origin}/?q=${encodeURIComponent(q)}${v ? `&v=${encodeURIComponent(v)}` : ''}`;
  const og = previewImage(url.origin, img);

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(title)} — Harpe</title>` +
    `<meta name="description" content="${esc(desc)}">` +
    `<meta property="og:type" content="article">` +
    `<meta property="og:site_name" content="Harpe">` +
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(canonical)}">` +
    `<meta property="og:image" content="${esc(og.url)}">` +
    `<meta property="og:image:secure_url" content="${esc(og.url)}">` +
    (og.type ? `<meta property="og:image:type" content="${og.type}">` : '') +
    `<meta property="og:image:alt" content="${esc(title)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${esc(title)}">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    `<meta name="twitter:image" content="${esc(og.url)}">` +
    `</head><body>` +
    `<p>${esc(title)}</p>` +
    `<img src="${esc(og.url)}" alt="${esc(title)}" width="600">` +
    `<p><a href="${esc(canonical)}">View on Harpe</a></p>` +
    `<script>location.replace(${JSON.stringify(canonical)})</script>` +
    `</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600, s-maxage=600' },
  });
}
