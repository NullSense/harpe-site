/**
 * Vercel Edge Middleware — dynamic link previews for a static SPA.
 *
 * Social crawlers (Twitter/Slack/Discord/Facebook/…) don't run JS, so a shared
 * `/?q=…&v=<id>` link would only ever show the static default card. This intercepts
 * crawler requests and returns a tiny HTML doc with PER-ITEM Open Graph tags
 * (title + image + description), then redirects real browsers to the SPA.
 *
 * Item data is taken from the share URL when present (`t`, `img`, `d` — embedded by
 * the Share button, zero extra cost), else resolved by re-running the search once.
 * Normal (non-crawler) requests pass straight through to the SPA untouched.
 */

export const config = { matcher: '/' };

const BOT =
  /(facebookexternalhit|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegrambot|linkedinbot|embedly|quora link preview|pinterest|redditbot|applebot|skypeuripreview|vkshare|bot\b|preview|crawler|spider)/i;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  // No embedded preview data → resolve the item by re-running the search once.
  if ((!title || !img) && !/^https?:/i.test(q)) {
    try {
      const r = await fetch(`${url.origin}/api/art?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(8000),
      });
      const j = (await r.json()) as { items?: Array<Record<string, string>> };
      const items = j.items || [];
      const it = (v && items.find((x) => x.id === v)) || items[0];
      if (it) {
        title = title || it.title;
        img = img || it.thumbUrl || it.previewUrl;
        desc = desc || [it.artist, it.date, it.medium].filter(Boolean).join(' · ');
      }
    } catch { /* fall back to defaults */ }
  }

  title = title || `${q} — Harpe`;
  desc = desc || `Search "${q}" across 15 open museum collections — free public-domain art & image search.`;
  const canonical = `${url.origin}/?q=${encodeURIComponent(q)}${v ? `&v=${encodeURIComponent(v)}` : ''}`;

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(title)} — Harpe</title>` +
    `<meta name="description" content="${esc(desc)}">` +
    `<meta property="og:type" content="article">` +
    `<meta property="og:site_name" content="Harpe">` +
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(canonical)}">` +
    (img ? `<meta property="og:image" content="${esc(img)}">` : '') +
    `<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">` +
    `<meta name="twitter:title" content="${esc(title)}">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    (img ? `<meta name="twitter:image" content="${esc(img)}">` : '') +
    `</head><body>` +
    `<p>${esc(title)}</p>` +
    (img ? `<img src="${esc(img)}" alt="${esc(title)}" width="600">` : '') +
    `<p><a href="${esc(canonical)}">View on Harpe</a></p>` +
    `<script>location.replace(${JSON.stringify(canonical)})</script>` +
    `</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600, s-maxage=600' },
  });
}
