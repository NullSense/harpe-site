/**
 * Resolve a single item to its link-preview fields (title/img/desc) for the
 * middleware's social-card path. Runs in the Node serverless runtime (full
 * power, reuses gatherSources) so it works where Vercel Edge cannot — edge
 * middleware can't reliably fetch its own /api/* functions, so the middleware
 * proxies here via the deployment URL instead.
 *
 * GET /api/preview?q=<query>&v=<item-id>  →  { title, img, desc }  (or {} if none)
 *
 * Rate limiting: applies the same rateLimit(clientIp(headers)) guard as
 * /api/art. On GuardError we return {} (status 200) rather than 429 so a
 * throttle never breaks the social card — preview must degrade gracefully.
 *
 * IP-attribution caveat: this endpoint is called server-to-server by
 * middleware.ts, so x-real-ip / x-forwarded-for may collapse to a shared Vercel
 * infra IP when CDN caching is cold. Accepting that: once the CDN warms the
 * response (s-maxage=3600) the same ?q= never reaches this function again, so
 * only genuinely distinct queries consume budget. A throttled infra IP therefore
 * means an attacker is hammering MANY distinct queries — exactly the abuse we
 * want to cap. The rate limit budget is the same 60 req/min used by /api/art;
 * legitimate social crawlers retry at most a handful of times per link and are
 * never hurt in practice because the CDN shields them.
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { type ArtItem, isQid } from '@harpe/core';
import { loadArtistPage } from '@harpe/sources';
import { GuardError, rateLimit, clientIp } from '../guard.js';
import { gatherSources } from './art.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  const v = typeof req.query.v === 'string' ? req.query.v : '';
  const artist = (typeof req.query.artist === 'string' ? req.query.artist : '').trim();
  if (!q && !artist) return res.status(200).json({});

  // Rate limit — degrade gracefully: a throttle returns {} (200) instead of
  // 429 so the social card always renders (empty card > broken page).
  try {
    await rateLimit(clientIp(req.headers as Record<string, string | string[] | undefined>));
  } catch (e) {
    if (e instanceof GuardError) return res.status(200).json({});
    throw e;
  }

  // A ?artist=<QID> link previews the ARTIST entity (name/portrait/bio), not a
  // single work — resolve it from the KG node. Falls through to the work search on
  // any miss so the card still renders.
  if (isQid(artist)) {
    try {
      const page = await loadArtistPage(artist);
      const e = page?.entity;
      if (e) {
        const img = e.imageCommons
          ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(e.imageCommons)}?width=1200`
          : '';
        const desc = [e.description, e.workCount ? `${e.workCount} works` : ''].filter(Boolean).join(' · ');
        return res.status(200).json({ title: e.labelEn || artist, img, desc });
      }
    } catch { /* fall through to the work search */ }
  }
  if (!q) return res.status(200).json({}); // artist miss + no query → nothing to show

  try {
    const named = await gatherSources(q);
    // Collect items as each source resolves, but cap the total wait — a slow
    // source (LoC/Europeana) must not stall the card past the middleware's budget.
    const items: ArtItem[] = [];
    const collect = named.map(([, p]) => p.then((arr) => { items.push(...arr); }, () => {}));
    await Promise.race([
      Promise.allSettled(collect),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    const it = (v && items.find((i) => i.id === v)) || items[0];
    if (!it) return res.status(200).json({});
    return res.status(200).json({
      title: it.title || '',
      img: it.previewUrl || it.thumbUrl || '',
      desc: [it.artist, it.date, it.medium].filter(Boolean).join(' · '),
    });
  } catch {
    return res.status(200).json({}); // never block the card on a resolve failure
  }
}
