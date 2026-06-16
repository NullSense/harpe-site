/**
 * Single catch-all Serverless Function for the whole API.
 *
 * Vercel's Hobby plan allows at most 12 Serverless Functions per deployment;
 * one-file-per-endpoint blew past that and froze production. This routes every
 * /api/<name> request to the matching module in src/lib/server/handlers, so the
 * function count stays at 1 no matter how many endpoints exist. Public URLs are
 * unchanged (/api/x, /api/tile, …).
 *
 * NOTE: with `framework: vite` (not Next.js) Vercel matches this catch-all for
 * all /api/* paths but does NOT populate `req.query.path`, so the endpoint name
 * is parsed from `req.url` (with req.query.path honoured if a runtime ever sets
 * it). Getting this wrong 404s every endpoint → infinite spinners on the client.
 */
import type { VercelRequest, VercelResponse } from '../src/lib/server/vercel.js';
import { handlers } from '../src/lib/server/handlers/index.js';

export function opFromRequest(req: Pick<VercelRequest, 'query' | 'url'>): string {
  const p = (req.query as Record<string, string | string[] | undefined>)?.path;
  if (Array.isArray(p) && p[0]) return p[0];
  if (typeof p === 'string' && p) return p;
  const path = (req.url || '').split('?')[0].replace(/^\/+/, '');
  const segs = path.split('/').filter(Boolean);
  const op = segs[0] === 'api' ? segs[1] : segs[0];
  return op ? decodeURIComponent(op) : '';
}

export default async function dispatch(req: VercelRequest, res: VercelResponse) {
  const op = opFromRequest(req);
  const handler = op ? handlers[op] : undefined;
  if (!handler) {
    res.status(404).json({ error: `unknown endpoint: ${op}` });
    return;
  }
  return handler(req, res);
}
