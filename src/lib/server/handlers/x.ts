/**
 * /api/x?id=<tweet-id>
 *
 * Resolves a public X / Twitter post's media (video MP4 variants + photos) via
 * Twitter's public syndication endpoint — no auth, no yt-dlp, serverless-friendly.
 * The site/extension paste an x.com/…/status/<id> link; this returns downloadable
 * media. Reusable by the browser extension.
 *
 * Fixed upstream host (cdn.syndication.twimg.com) → no user-supplied URL, no SSRF
 * surface. Rate-limited + cached. Returns 200 with media:[] for public posts;
 * 404/422 for protected/deleted/media-less posts.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { fetchWithTimeout } from '../fetchWithTimeout.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12_000;

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** The obfuscation token the syndication endpoint expects, derived from the id. */
export function tweetToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '');
}

/** "…/1080x1080/…mp4" → "1080p" (falls back to the bitrate). */
export function variantLabel(url: string, bitrate: number): string {
  const m = /\/(\d+)x(\d+)\//.exec(url);
  if (m) return `${m[2]}p`;
  return bitrate ? `${Math.round(bitrate / 1000)}kbps` : 'video';
}

interface MediaVideo { type: 'video'; poster: string; best: string; variants: Array<{ label: string; url: string; bitrate: number }>; }
interface MediaPhoto { type: 'photo'; url: string; }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method !== 'GET') { res.setHeader('Cache-Control', 'no-store'); return res.status(405).json({ error: 'Method not allowed' }); }

  const id = s(req.query.id).trim();
  if (!/^\d{5,25}$/.test(id)) { res.setHeader('Cache-Control', 'no-store'); return res.status(400).json({ error: 'Provide a numeric tweet id' }); }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try { await rateLimit(ip); }
  catch (e) { if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); } throw e; }

  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tweetToken(id)}&lang=en`;
    const r = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: `Upstream ${r.status}` }); }
    const j = await r.json() as {
      __typename?: string; text?: unknown;
      user?: { name?: unknown; screen_name?: unknown };
      mediaDetails?: Array<{ type?: string; media_url_https?: unknown; video_info?: { variants?: Array<{ content_type?: string; url?: unknown; bitrate?: unknown }> } }>;
    };
    if (!j || j.__typename === 'TweetTombstone') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Post not found, protected, or deleted' });
    }

    const media: Array<MediaVideo | MediaPhoto> = [];
    for (const m of (j.mediaDetails ?? [])) {
      if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info?.variants) {
        const variants = m.video_info.variants
          .filter((v) => v.content_type === 'video/mp4' && s(v.url))
          .map((v) => ({ url: s(v.url), bitrate: Number(v.bitrate) || 0 }))
          .sort((a, b) => b.bitrate - a.bitrate)
          .map((v) => ({ ...v, label: variantLabel(v.url, v.bitrate) }));
        if (variants.length) media.push({ type: 'video', poster: s(m.media_url_https), best: variants[0].url, variants });
      } else if (m.type === 'photo' && s(m.media_url_https)) {
        media.push({ type: 'photo', url: s(m.media_url_https) });
      }
    }
    if (media.length === 0) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'No downloadable media in that post' }); }

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      id,
      text: s(j.text),
      author: s(j.user?.name) || s(j.user?.screen_name),
      media,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'Tweet fetch timed out' });
    return res.status(502).json({ error: 'Tweet fetch failed' });
  }
}
