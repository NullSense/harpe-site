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

import type { VercelRequest, VercelResponse } from '../vercel.js';
import { fetch } from 'undici';
import { createHash } from 'node:crypto';
import { enforceRateLimit } from '../guard.js';

const TIMEOUT_MS = 25_000;
const CACHE_TTL_S = 60 * 60 * 24 * 30; // 30 days
const MAX_TOKENS = 1400;               // ~350-550 words of educational prose
const WIKI_MAX_CHARS = 5000;           // cap the Wikipedia context fed to the LLM
const UA = 'HarpeArtSearch/1.0 (https://harpe-site.vercel.app)';
const ANALYZE_VERSION = 'v2';          // bump to invalidate cached older/shorter analyses

interface SourceRecord {
  source?: string;
  date?: string;
  medium?: string;
  culture?: string;
  creditLine?: string;
  description?: string;
  sourceUrl?: string;
  artworkType?: string;
  style?: string;
  tags?: string[];
  inscriptions?: string;
  accessionNumber?: string;
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

// All configured providers, in preference order. The handler tries them in turn,
// so a quota-blocked/down provider (e.g. Gemini 429) falls through to the next.
function pickProviders(): Provider[] {
  const out: Provider[] = [];
  // Google AI Studio (Gemini) — generous free tier when the project's quota is OK.
  const gem = process.env.GEMINI_API_KEY;
  if (gem) {
    const model = process.env.HARPE_ANALYZE_MODEL || 'gemini-2.0-flash';
    out.push({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': gem },
      body: (prompt) => ({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 },
      }),
      extract: (d) => s((d as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
        ?.candidates?.[0]?.content?.parts?.map((p) => s(p.text)).join('') ?? ''),
    });
  }
  // Groq — fast, free tier (OpenAI-compatible).
  const groq = process.env.GROQ_API_KEY;
  if (groq) {
    const model = process.env.HARPE_ANALYZE_MODEL || 'llama-3.3-70b-versatile';
    out.push({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${groq}` },
      body: (prompt) => ({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
      extract: (d) => s((d as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content),
    });
  }
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
    out.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ork}`,
        'HTTP-Referer': 'https://harpe-site.vercel.app',
        'X-Title': 'Harpe',
      },
      body: (prompt) => ({
        models,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        ...(web ? { plugins: [{ id: 'web', max_results: 3 }] } : {}),
      }),
      extract: (d) => s((d as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content),
    });
  }
  const ak = process.env.ANTHROPIC_API_KEY;
  if (ak) {
    const model = process.env.HARPE_ANALYZE_MODEL || 'claude-haiku-4-5-20251001';
    out.push({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': ak, 'anthropic-version': '2023-06-01' },
      body: (prompt) => ({ model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
      extract: (d) => s((d as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text),
    });
  }
  return out;
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
  return `analyze:${ANALYZE_VERSION}:${base}:${h}`;
}

// ─── Wikipedia retrieval (RAG grounding — free, no key) ────────────────────────
// Find the encyclopedia article for the artwork and pull its plain-text so the LLM
// can teach real history/iconography/interpretation instead of inventing it. Fixed
// public host (no user URL → no SSRF surface), best-effort (null on any failure).

export interface WikiContext { title: string; url: string; extract: string; }

const GENERIC_TITLE = /^(untitled|study|sketch|portrait of a (?:man|woman|lady|gentleman)|landscape|still life|no\.?\s*\d+)\b/i;

export async function fetchWikipedia(title: string, artist: string, signal: AbortSignal): Promise<WikiContext | null> {
  if (!title || title.length < 4 || GENERIC_TITLE.test(title)) return null; // too generic to disambiguate
  const norm = (x: string) => x.toLowerCase();
  try {
    // 1) Find the best-matching page.
    const q = [title, artist].filter(Boolean).join(' ');
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srlimit=5&srprop=&srsearch=${encodeURIComponent(q)}`;
    const sr = await fetch(searchUrl, { signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!sr.ok) return null;
    const hits = ((await sr.json()) as { query?: { search?: Array<{ title?: string }> } }).query?.search ?? [];
    if (!hits.length) return null;
    const titleWords = new Set(norm(title).split(/\W+/).filter((w) => w.length > 3));
    const best = hits.find((h) => h.title && [...titleWords].some((w) => norm(h.title!).includes(w)))?.title ?? hits[0].title;
    if (!best) return null;

    // 2) Fetch the plain-text extract + canonical URL (follow redirects).
    const exUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=extracts|info&explaintext=1&exsectionformat=plain&inprop=url&redirects=1&titles=${encodeURIComponent(best)}`;
    const er = await fetch(exUrl, { signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!er.ok) return null;
    const pages = ((await er.json()) as { query?: { pages?: Record<string, { extract?: string; fullurl?: string; title?: string }> } }).query?.pages ?? {};
    const page = Object.values(pages)[0];
    const extract = s(page?.extract).replace(/\n{3,}/g, '\n\n').trim();
    if (extract.length < 160) return null; // too thin to be useful

    // 3) Guard against grabbing the wrong page: if we know the artist, the article
    //    should mention their surname — otherwise it's likely a different subject.
    if (artist) {
      const surname = norm(artist).split(/\W+/).filter(Boolean).pop() ?? '';
      if (surname.length > 2 && !norm(extract).includes(surname)) return null;
    }
    return { title: s(page?.title) || best, url: s(page?.fullurl), extract: extract.slice(0, WIKI_MAX_CHARS) };
  } catch {
    return null;
  }
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

export function buildPrompt(title: string, artist: string, items: SourceRecord[], wiki: WikiContext | null): string {
  const blocks = items.map((it, i) => {
    const lines = [
      `[Source ${i + 1}: ${s(it.source)}]`,
      it.date && `date: ${s(it.date)}`,
      it.medium && `medium: ${s(it.medium)}`,
      it.artworkType && `type: ${s(it.artworkType)}`,
      it.style && `style/period: ${s(it.style)}`,
      it.culture && `origin/holder: ${s(it.culture)}`,
      it.creditLine && `credit: ${s(it.creditLine)}`,
      it.accessionNumber && `accession no.: ${s(it.accessionNumber)}`,
      Array.isArray(it.tags) && it.tags.length && `subjects/tags: ${it.tags.map(s).filter(Boolean).slice(0, 20).join(', ')}`,
      it.inscriptions && `inscriptions: ${s(it.inscriptions)}`,
      it.description && `description: ${s(it.description)}`,
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');

  const wikiBlock = wiki
    ? `\nENCYCLOPEDIC BACKGROUND (Wikipedia — "${wiki.title}"):\n${wiki.extract}\n`
    : '';

  return (
    `You are an engaging art historian and educator writing for a curious general ` +
    `audience meeting this artwork for the first time. Teach them about it — make ` +
    `them understand and want to keep looking.\n\n` +
    `Write flowing prose under these short plain-text section labels (each on its ` +
    `own line, in Title Case followed by a colon):\n` +
    `- The Subject: what is depicted and the story, myth, event, or person behind ` +
    `it — who the figures are and what moment we are seeing.\n` +
    `- Context: the artist, when and why it was made, the movement/period, and the ` +
    `historical moment around it.\n` +
    `- How to Look: the composition — how the eye is led through the picture, and ` +
    `the use of light, line, gesture, colour, and focal point, and what those ` +
    `choices make you feel or understand.\n` +
    `- Meaning: symbolism, interpretation, any scholarly debate, and why it matters.\n\n` +
    `RULES:\n` +
    `- Ground everything in the context below. Use the encyclopedic background for ` +
    `history, narrative, and interpretation; use the museum records for catalogue ` +
    `facts (date, medium, where held).\n` +
    `- Be vivid and specific, but do NOT invent facts the context doesn't support. ` +
    `If a section is thin on evidence, keep it brief rather than padding.\n` +
    `- ~350-550 words total. Plain text (no markdown headers or bullets in the body).\n` +
    `- End with one line "Facts: <date> · <medium> · <where held>"` +
    (wiki ? ` and a final line "Learn more: ${wiki.url}".` : `.`) +
    `\n\n` +
    `ARTWORK: "${title}"${artist ? ` — ${artist}` : ''}\n` +
    wikiBlock +
    `\nMUSEUM RECORDS:\n${blocks}`
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

  const providers = pickProviders();
  if (providers.length === 0) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(501).json({ error: 'Analysis is not enabled (set GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY).' });
  }

  if (!(await enforceRateLimit(req, res))) return;

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
      artworkType: s(o.artworkType), style: s(o.style), inscriptions: s(o.inscriptions).slice(0, 500),
      accessionNumber: s(o.accessionNumber),
      tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(s).filter(Boolean).slice(0, 20) : undefined,
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

  // ── LLM synthesis — try each provider in turn; fall through on failure ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Retrieval-augment with Wikipedia so the analysis can teach real history /
  // narrative / interpretation. Best-effort: null → metadata-only (still works).
  const wiki = await fetchWikipedia(title, artist, controller.signal);
  const prompt = buildPrompt(title, artist, items, wiki);
  const wikipedia = wiki ? { title: wiki.title, url: wiki.url } : undefined;
  let lastErr = 'no provider succeeded';
  try {
    for (const provider of providers) {
      try {
        const r = await fetch(provider.url, {
          method: 'POST',
          signal: controller.signal,
          headers: provider.headers,
          body: JSON.stringify(provider.body(prompt)),
        });
        if (!r.ok) { lastErr = `LLM error ${r.status}: ${(await r.text()).slice(0, 160)}`; continue; }
        const analysis = provider.extract(await r.json()).trim();
        if (!analysis) { lastErr = 'empty analysis'; continue; }

        const payload = { analysis, contributors, wikipedia };
        if (redis) { try { await redis.set(ck, JSON.stringify(payload), { ex: CACHE_TTL_S }); } catch { /* ignore */ } }
        res.setHeader('Cache-Control', 'public, s-maxage=86400');
        return res.status(200).json({ ...payload, cached: false });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw e; // overall timeout → stop
        lastErr = e instanceof Error ? e.message : 'request failed';
      }
    }
    // every provider failed
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'All AI providers are busy right now — please try again shortly.', detail: lastErr.slice(0, 200) });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e instanceof Error && e.name === 'AbortError') return res.status(504).json({ error: 'Analysis timed out' });
    return res.status(502).json({ error: 'Analysis failed' });
  } finally {
    clearTimeout(timer);
  }
}
