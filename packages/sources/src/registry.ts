/**
 * Source registry: the single list of every museum/gallery integration.
 * Reused by both the Vercel batch handler and the streaming handler so the
 * source list is defined in exactly one place.
 */
import type { SourceAdapter, ArtItem } from '@harpe/core';
import {
  fetchAic, fetchMet, fetchCleveland, fetchCommons, fetchWikiArt, fetchVam,
  fetchWellcome, fetchSmk, fetchNasjonalmuseet, fetchDigitalNZ, fetchWikidata,
  fetchLoc, fetchEuropeana, fetchHarvard, fetchSmithsonian, fetchParisMusees,
  fetchDumpSource, fetchNypl, dumpDatasetEnv,
} from './adapters.js';
export { mapPool } from './helpers.js';

/** The source registry — the single list of every integration. */
export const SOURCES: SourceAdapter[] = [
  { key: 'aic', label: 'AIC', fetch: fetchAic },
  { key: 'met', label: 'Met', fetch: fetchMet },
  { key: 'cleveland', label: 'Cleveland', fetch: fetchCleveland },
  { key: 'commons', label: 'Commons', fetch: fetchCommons },
  { key: 'wikiart', label: 'WikiArt', fetch: fetchWikiArt },
  { key: 'vam', label: 'V&A', fetch: fetchVam },
  { key: 'wellcome', label: 'Wellcome', fetch: fetchWellcome },
  { key: 'smk', label: 'SMK', fetch: fetchSmk },
  { key: 'nasjonalmuseet', label: 'Nasjonalmuseet', fetch: fetchNasjonalmuseet },
  { key: 'digitalnz', label: 'DigitalNZ', fetch: fetchDigitalNZ },
  { key: 'wikidata', label: 'Wikidata', fetch: fetchWikidata },
  { key: 'loc', label: 'Library of Congress', fetch: fetchLoc },
  // Keyed sources — only queried when their server-only key/env is configured.
  { key: 'europeana', label: 'Europeana', fetch: fetchEuropeana, requiresEnv: 'EUROPEANA_API_KEY' },
  { key: 'harvard', label: 'Harvard', fetch: fetchHarvard, requiresEnv: 'HARVARD_API_KEY' },
  { key: 'si', label: 'Smithsonian', fetch: fetchSmithsonian, requiresEnv: 'SMITHSONIAN_API_KEY' },
  // Paris Musées' Drupal GraphQL has no fast fulltext index; best-effort, also
  // covered by Europeana. Its own timeout caps latency.
  { key: 'parismusees', label: 'Paris Musées', fetch: fetchParisMusees, requiresEnv: 'PARIS_MUSEES_TOKEN' },
  // Dump-backed first-class sources. The adapters share one cached HF /search
  // call per query, then split rows by the normalized dump `source` field.
  { key: 'moma', label: 'MoMA', fetch: (q) => fetchDumpSource('moma', q), requiresAnyEnv: [dumpDatasetEnv('moma'), 'HARPE_DUMP_DATASET'] },
  { key: 'nga', label: 'NGA', fetch: (q) => fetchDumpSource('nga', q), requiresAnyEnv: [dumpDatasetEnv('nga'), 'HARPE_DUMP_DATASET'] },
  { key: 'mia', label: 'MIA', fetch: (q) => fetchDumpSource('mia', q), requiresAnyEnv: [dumpDatasetEnv('mia'), 'HARPE_DUMP_DATASET'] },
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
  return activeSources().map((s) => [s.label, s.fetch(q)] as [string, Promise<ArtItem[]>]);
}
