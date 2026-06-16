/**
 * Single catch-all Serverless Function for the whole API.
 *
 * Vercel's Hobby plan allows at most 12 Serverless Functions per deployment;
 * one-file-per-endpoint blew past that and froze production. This routes every
 * /api/<name> request to the matching module in src/lib/server/handlers, so the
 * function count stays at 1 no matter how many endpoints exist. Public URLs are
 * unchanged (/api/x, /api/tile, …).
 */
import type { VercelRequest, VercelResponse } from '../src/lib/server/vercel.js';
import { handlers } from '../src/lib/server/handlers/index.js';

export default async function dispatch(req: VercelRequest, res: VercelResponse) {
  const p = (req.query as Record<string, string | string[] | undefined>).path;
  const op = Array.isArray(p) ? p[0] : p;
  const handler = op ? handlers[op] : undefined;
  if (!handler) {
    res.status(404).json({ error: `unknown endpoint: ${op ?? ''}` });
    return;
  }
  return handler(req, res);
}
