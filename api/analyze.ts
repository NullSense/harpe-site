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
import { createHash } from 'node:crypto';
import { GuardError, rateLimit, clientIp } from './_guard.js';

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

// LLM provider — prefer OpenRouter (free `:free` models, OpenAI-compatible),
// fall back to Anthropic. Both keys are server-only.
interface Provider {
  url: string;
  headers: Record<string, string>;
  body: (prompt: string) => unknown;
  extract: (data: unknown) => string;
}

function pickProvider(): Provider | null {
  const ork = process.env.OPENROUTER_API_KEY;
  if (ork) {
    // Primary model + free fallbacks: OpenRouter tries them in order, so a
    // rate-limited/unavailable free model auto-falls-through to the next.
    const primary = process.env.HARPE_ANALYZE_MODEL || 'google/gemini-2.0-flash-exp:free';
    // Free-model fallback: OpenRouter routes to the first available so a
    // rate-limited model falls through to the next. NOTE: OpenRouter caps this
    // array at 3 — diverse picks maximise the chance one isn't rate-limited.
    const models = [...new Set([
      primary,
      'deepseek/deepseek-chat-v3-0324:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ])].slice(0, 3);
    // Opt-in Exa-powered web search to enrich the analysis with live context.
    const web = process.env.HARPE_ANALYZE_WEB === '1';
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ork}`,
        'HTTP-Referer': 'https://harpe-site.vercel.app',
        'X-Title': 'Harpe',
      },
      body: (prompt) => ({
        models,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
        ...(web ? { plugins: [{ id: 'web', max_results: 3 }] } : {}),
      }),
      extract: (d) => s((d as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content),
    };
  }
  const ak = process.env.ANTHROPIC_API_KEY;
  if (ak) {
    const model = process.env.HARPE_ANALYZE_MODEL || 'claude-haiku-4-5-20251001';
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: (prompt) => ({ model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      extract: (d) => s((d as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text),
    };
  }
  return null;
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

// Key on the artwork AND a hash of the supplied source records. Because `items`
// come from the request body, keying on title/artist alone would let a caller
// poison the cache for a clean title with junk descriptions that then get served
// to everyone. The items-hash makes tampered input produce a different key.
function cacheKey(title: string, artist: string, items: SourceRecord[]): string {
  const base = `${title}|${artist}`.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160);
  const norm = items
    .map((i) => ({ s: i.source, d: i.date, m: i.medium, c: i.culture, cl: i.creditLine, desc: i.description }))
    .sort((a, b) => (a.s || '').localeCompare(b.s || ''));
  const h = createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
  return `analyze:${base}:${h}`;
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

  const provider = pickProvider();
  if (!provider) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'Analysis is not enabled (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY).' });
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
  const ck = cacheKey(title, artist, items);
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
    const prompt = buildPrompt(title, artist, items);
    const r = await fetch(provider.url, {
      method: 'POST',
      signal: controller.signal,
      headers: provider.headers,
      body: JSON.stringify(provider.body(prompt)),
    });
    if (!r.ok) {
      const detail = await r.text();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: `LLM error ${r.status}`, detail: detail.slice(0, 200) });
    }
    const data = await r.json();
    const analysis = provider.extract(data).trim();
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
