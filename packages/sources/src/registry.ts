/**
 * Source registry: the single list of every museum/gallery integration.
 * Reused by both the Vercel batch handler and the streaming handler so the
 * source list is defined in exactly one place.
 */
import type { SourceAdapter, ArtItem } from '@harpe/core';
import {
  fetchCommons, fetchWikiArt, fetchVam,
  fetchNasjonalmuseet, fetchDigitalNZ,
  fetchEuropeana, fetchHarvard, fetchParisMusees,
  fetchDumpSource, fetchNypl, dumpDatasetEnv,
} from './adapters.js';
import { runSource } from './resilience.js';
export { mapPool } from './helpers.js';

// A source whose full open-data dump has been ingested into the HF dataset
// (scripts/ingest-art-dumps/ingest.py) is served from that deep index — one
// shared, cached HF /search per query, split by the normalized `source` field —
// instead of sampling its live API. Activates only when HARPE_DUMP_DATASET (or a
// per-source override) is set, so a dump-less environment falls back gracefully.
const dump = (key: ArtItem['source'], label: string): SourceAdapter => ({
  key, label, dumpBacked: true,
  fetch: (q) => fetchDumpSource(key as Parameters<typeof fetchDumpSource>[0], q),
  requiresAnyEnv: [dumpDatasetEnv(key as Parameters<typeof dumpDatasetEnv>[0]), 'HARPE_DUMP_DATASET'],
});

/** The source registry — the single list of every integration. */
export const SOURCES: SourceAdapter[] = [
  // ─ Dump-backed deep-index sources (exhaustive search; see SOURCES.md) ─
  dump('moma', 'MoMA'),
  dump('nga', 'NGA'),
  dump('mia', 'MIA'),
  dump('aic', 'AIC'),
  dump('cleveland', 'Cleveland'),
  dump('wellcome', 'Wellcome'),
  dump('smk', 'SMK'),
  dump('si', 'Smithsonian'),
  dump('wikidata', 'Wikidata'),
  dump('met', 'Met'),                    // Met's own HF open-access dump (API is Incapsula-walled; CDN is open)
  dump('loc', 'Library of Congress'),    // P&P photography, IIIF images
  // ─ Live-API sources (no usable bulk dump — see SOURCES.md "Not pursued") ─
  { key: 'commons', label: 'Commons', fetch: fetchCommons },
  { key: 'wikiart', label: 'WikiArt', fetch: fetchWikiArt },
  { key: 'vam', label: 'V&A', fetch: fetchVam },
  { key: 'nasjonalmuseet', label: 'Nasjonalmuseet', fetch: fetchNasjonalmuseet },
  { key: 'digitalnz', label: 'DigitalNZ', fetch: fetchDigitalNZ },
  // Keyed live sources — only queried when their server-only key/env is configured.
  { key: 'europeana', label: 'Europeana', fetch: fetchEuropeana, requiresEnv: 'EUROPEANA_API_KEY' },
  { key: 'harvard', label: 'Harvard', fetch: fetchHarvard, requiresEnv: 'HARVARD_API_KEY' },
  // Paris Musées' Drupal GraphQL has no fast fulltext index; best-effort, also
  // covered by Europeana. Its own timeout caps latency.
  { key: 'parismusees', label: 'Paris Musées', fetch: fetchParisMusees, requiresEnv: 'PARIS_MUSEES_TOKEN',
    disabled: true, note: 'GraphQL schema drift (fieldAuteurs removed) — disabled until the query is rebuilt against the current NodeOeuvre schema' },
  // NYPL token auth needs HTTP/2; Vercel egress forces HTTP/1.1 (→ "Access
  // denied"). Works locally over h2. Photography is covered by LoC meanwhile.
  { key: 'nypl', label: 'NYPL', fetch: fetchNypl, requiresEnv: 'NYPL_API_TOKEN', disabled: true,
    note: 'token auth needs HTTP/2; disabled on Vercel (HTTP/1.1 egress)' },
];

/** Active sources for this environment: enabled + (keyless or key present). */
export function activeSources(env: NodeJS.ProcessEnv = process.env): SourceAdapter[] {
  return SOURCES.filter((s) => {
    if (s.disabled) return false;
    if (s.requiresEnv && !env[s.requiresEnv]) return false;
    if (s.requiresAnyEnv && !s.requiresAnyEnv.some((name) => !!env[name])) return false;
    return true;
  });
}

export async function gatherSources(q: string): Promise<Array<[string, Promise<ArtItem[]>]>> {
  // Each live source runs through its circuit breaker (dump-backed sources carry
  // their own shared HF policy) — a degraded upstream fails fast instead of
  // taxing every query. See resilience.ts.
  return activeSources().map((s) => [s.label, runSource(s, q)] as [string, Promise<ArtItem[]>]);
}
