/**
 * POST /api/analyze
 *
 * The "mega-analysis": given one artwork that appears across several of our
 * sources, MERGE all their metadata + descriptions and pass the bundle to an LLM
 * to produce a single synthesized, educational analysis — the best of every
 * source combined into one.
 *
 * Request body: { title, artist, items: [{ source, date, medium, culture,
 *   creditLine, description, sourceUrl }] }
 * Response: { analysis: string, contributors: string[], cached: boolean }
 *
 * DORMANT until ANTHROPIC_API_KEY is set (server-only env var — never reaches the
 * browser). Results are cached (Upstash Redis when configured) so each artwork is
 * synthesized at most once. Rate-limited per IP.
 */

import type { VercelRequest, VercelResponse } from './_vercel.js';
import { fetch } from 'undici';
import { GuardError, rateLimit, clientIp } from './_guard.js';

const MODEL = process.env.HARPE_ANALYZE_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 25_000;
const CACHE_TTL_S = 60 * 60 * 24 * 30; // 30 days

interface SourceRecord {
  source?: string;
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ─── Optional Upstash cache (shares env with the rate limiter) ────────────────
let _redis: { get: (k: string) => Promise<unknown>; set: (k: string, v: string, o: { ex: number }) => Promise<unknown> } | null | undefined;
async function getRedis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) { _redis = null; return null; }
  try {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({ url, token }) as unknown as typeof _redis;
  } catch { _redis = null; }
  return _redis;
}

function cacheKey(title: string, artist: string): string {
  return 'analyze:' + `${title}|${artist}`.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(title: string, artist: string, items: SourceRecord[]): string {
  const blocks = items.map((it, i) => {
    const lines = [
      `[Source ${i + 1}: ${s(it.source)}]`,
      it.date && `date: ${s(it.date)}`,
      it.medium && `medium: ${s(it.medium)}`,
      it.culture && `origin/holder: ${s(it.culture)}`,
      it.creditLine && `credit: ${s(it.creditLine)}`,
      it.description && `description: ${s(it.description)}`,
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');

  return (
    `You are an art historian writing for a curious general audience. Several ` +
    `museum/collection databases describe what appears to be the SAME artwork. ` +
    `Synthesize their information into ONE clear, engaging account.\n\n` +
    `RULES:\n` +
    `- Use ONLY the facts in the sources below. Do NOT invent anything.\n` +
    `- Merge overlapping facts; if sources disagree, note it briefly.\n` +
    `- If sources are thin, keep it short — never pad with speculation.\n` +
    `- ~150-220 words of prose, then a short "Facts:" list (date, medium, where held).\n` +
    `- Plain text, no markdown headers.\n\n` +
    `ARTWORK: "${title}"${artist ? ` — ${artist}` : ''}\n\n` +
    `SOURCES:\n${blocks}`
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method !== 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(405).json({ error: 'POST only' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'Analysis is not enabled (no ANTHROPIC_API_KEY configured).' });
  }

  const ip = clientIp(req.headers as Record<string, string | string[] | undefined>);
  try {
    await rateLimit(ip);
  } catch (e) {
    if (e instanceof GuardError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ error: e.message }); }
    throw e;
  }

  let body: { title?: unknown; artist?: unknown; items?: unknown };
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof body) ?? {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const title = s(body.title).trim();
  const artist = s(body.artist).trim();
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!title || rawItems.length === 0) {
    return res.status(400).json({ error: 'Provide a title and at least one source item' });
  }

  // Keep only the metadata we need; cap to keep the prompt bounded.
  const items: SourceRecord[] = rawItems.slice(0, 12).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      source: s(o.source), date: s(o.date), medium: s(o.medium), culture: s(o.culture),
      creditLine: s(o.creditLine), description: s(o.description).slice(0, 1500), sourceUrl: s(o.sourceUrl),
    };
  });
  const contributors = [...new Set(items.map((i) => i.source).filter(Boolean))] as string[];

  // ── Cache lookup ──
  const ck = cacheKey(title, artist);
  const redis = await getRedis();
  if (redis) {
    try {
      const hit = await redis.get(ck);
      if (hit) {
        const cached = typeof hit === 'string' ? JSON.parse(hit) : hit;
        res.setHeader('Cache-Control', 'public, s-maxage=86400');
        return res.status(200).json({ ...cached, cached: true });
      }
    } catch { /* ignore cache errors */ }
  }

  // ── LLM synthesis ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: buildPrompt(title, artist, items) }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: `LLM error ${r.status}`, detail: detail.slice(0, 200) });
    }
    const data = await r.json() as { content?: Array<{ text?: unknown }> };
    const analysis = s(data.content?.[0]?.text).trim();
    if (!analysis) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'Empty analysis' });
    }

    const payload = { analysis, contributors };
    if (redis) { try { await redis.set(ck, JSON.stringify(payload), { ex: CACHE_TTL_S }); } catch { /* ignore */ } }

    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    return res.status(200).json({ ...payload, cached: false });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'Analysis timed out' });
    return res.status(502).json({ error: 'Analysis failed' });
  } finally {
    clearTimeout(timer);
  }
}
