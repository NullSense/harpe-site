/**
 * Resolve a single item to its link-preview fields (title/img/desc) for the
 * middleware's social-card path. Runs in the Node serverless runtime (full
 * power, reuses gatherSources) so it works where Vercel Edge cannot — edge
 * middleware can't reliably fetch its own /api/* functions, so the middleware
 * proxies here via the deployment URL instead.
 *
 * GET /api/preview?q=<query>&v=<item-id>  →  { title, img, desc }  (or {} if none)
 */
import type { VercelRequest, VercelResponse } from '../vercel.js';
import { gatherSources, type ArtItem } from './art.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  const v = typeof req.query.v === 'string' ? req.query.v : '';
  if (!q) return res.status(200).json({});

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
