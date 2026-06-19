/**
 * /api/art-stream?q=<query>
 *
 * Server-Sent Events endpoint for federated art search. Results arrive
 * per-source as each upstream API responds, instead of waiting for all
 * sources to settle. The browser sees results progressively.
 *
 * Event stream format:
 *   data: {"source":"AIC","items":[...]}          — source resolved
 *   data: {"source":"Met","error":"HTTP 503"}     — source failed
 *   data: {"done":true,"analyzeEnabled":true}     — all settled; stream ends
 *
 * Security: same rate limiting as art.ts. Hard 9s overall timeout.
 */

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { enforceRateLimit } from '../guard.js';
import { gatherSources } from './art.js';

// ─── Node streaming cast (mirrors fetch.ts pattern) ───────────────────────────

interface NodeWritable {
  write(chunk: string): boolean;
  end(): void;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

const OVERALL_TIMEOUT_MS = 9_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'Missing or empty ?q= parameter' });
  }

  // Rate limit
  if (!(await enforceRateLimit(req, res))) return;

  // Switch to SSE mode — after this point we stream directly via Node's
  // ServerResponse (the VercelResponse wrapper doesn't expose .write/.end).
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.status(200);

  const out = res as unknown as NodeWritable;

  const analyzeEnabled = Boolean(
    process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY,
  );

  // Hard timeout — end the stream even if some sources are still pending.
  let streamEnded = false;
  const endStream = () => {
    if (streamEnded) return;
    streamEnded = true;
    out.write(`data: ${JSON.stringify({ done: true, analyzeEnabled })}\n\n`);
    out.end();
  };

  const overallTimer = setTimeout(endStream, OVERALL_TIMEOUT_MS);

  const sources = await gatherSources(q);

  // Fan-out: attach .then/.catch to each source promise independently so one
  // failure never kills the stream for other sources.
  const perSource = sources.map(([name, promise]) =>
    promise
      .then((items) => {
        if (streamEnded) return;
        out.write(`data: ${JSON.stringify({ source: name, items })}\n\n`);
      })
      .catch((reason: unknown) => {
        if (streamEnded) return;
        out.write(
          `data: ${JSON.stringify({ source: name, error: String(reason) })}\n\n`,
        );
      }),
  );

  // When every source has settled (resolved or rejected), close cleanly.
  Promise.allSettled(perSource).then(() => {
    clearTimeout(overallTimer);
    endStream();
  });
}
