/**
 * CLI art-search façade — thin wrapper around @harpe/sources + @harpe/core ranking.
 *
 * The 10 duplicate museum adapters that used to live here (with a separate
 * Candidate type) are removed. All adapters now live in @harpe/sources and return
 * ArtItem[] directly. The CLI uses ArtItem everywhere instead of Candidate.
 *
 * Firecrawl (a CLI-only web-image search) is kept here since it is not a museum
 * source and is not part of the server-side SOURCES registry.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UA } from './config.js';
import type { ArtItem } from '@harpe/core';
import { rankResults, qualityScore } from '@harpe/core';
import { SOURCES, activeSources as sourcesActiveSources } from '@harpe/sources';

// Re-export for callers that may use SOURCES (e.g. tests).
export { SOURCES };

// ─── Firecrawl (CLI-only web image search) ───────────────────────────────────

/** Firecrawl image search (requires FIRECRAWL_API_KEY or ~/.config/grab/firecrawl.key). */
async function firecrawlKey(): Promise<string | null> {
  const env = process.env.FIRECRAWL_API_KEY;
  if (env) return env;
  const keyFile = join(homedir(), '.config', 'grab', 'firecrawl.key');
  try {
    const v = (await readFile(keyFile, 'utf8')).trim();
    return v || null;
  } catch {
    return null;
  }
}

async function fetchFirecrawl(q: string): Promise<ArtItem[]> {
  const key = await firecrawlKey();
  if (!key) return [];
  const r = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      query: `${q} larger:1200x1200`,
      sources: ['images'],
      limit: 12,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json() as Record<string, unknown>;
  const images = ((j.data as Record<string, unknown>) ?? {}).images as Array<Record<string, unknown>> ?? [];
  const items: ArtItem[] = [];
  for (const im of images) {
    const u = String(im.imageUrl ?? '');
    const w = Number(im.imageWidth ?? 0);
    const h = Number(im.imageHeight ?? 0);
    if (!u || w <= 0 || h <= 0) continue;
    items.push({
      id: `web-${items.length}`,
      title: String(im.title ?? 'web image'),
      artist: '',
      dimensions: `${w} × ${h} px`,
      thumbUrl: u,
      previewUrl: u,
      fullUrl: u,
      width: w,
      height: h,
      format: 'jpeg',
      lossless: false,
      downloads: [{ label: 'Image', url: u, format: 'jpeg', lossless: false }],
      source: 'commons', // nearest valid source key; firecrawl is web-only
      isPublicDomain: false,
    });
  }
  return items;
}

// ─── Active sources for the CLI ──────────────────────────────────────────────
// The CLI uses the same SOURCES registry as the server but also includes
// Firecrawl (not a museum source — CLI only).

/**
 * Query all active museum sources + Firecrawl in parallel, swallowing per-source
 * errors. Returns a flat list of all ArtItems gathered.
 */
export async function gather(q: string): Promise<ArtItem[]> {
  const active = sourcesActiveSources();
  const fns = [...active.map((s) => s.fetch), fetchFirecrawl];
  const results = await Promise.allSettled(fns.map((fn) => fn(q)));
  const out: ArtItem[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled') out.push(...res.value);
  }
  return out;
}

/** Convenience: gather then rank using @harpe/core's RRF pipeline. */
export async function searchArt(q: string): Promise<ArtItem[]> {
  const items = await gather(q);
  return rankResults(items, q, { qualityOf: (it) => qualityScore(it, q) });
}
