/**
 * High-level search + knowledge-graph orchestration — the engine's "verbs" composed
 * from the source adapters + the @harpe/core ranking pipeline. ONE implementation
 * shared by every frontend: the Vercel handlers (art / artist / depicts) AND the MCP
 * server, so ranking/dedup/entity-page logic never forks.
 */
import {
  rankResults, qualityScore,
  type ArtItem, type ArtistEntity, type SubjectEntity,
} from '@harpe/core';
import { gatherSources } from './registry.js';
import { fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity, fetchDumpSearch } from './adapters.js';

export const DEFAULT_MAX_ITEMS = 40;
const WORKS_CAP = 100;

/** Federated + dump search: fan out to every active source, collect, then dedupe +
 *  RRF-rank via the shared pipeline. A failing source becomes a warning, not an error. */
export async function searchArt(
  query: string,
  opts: { max?: number } = {},
): Promise<{ items: ArtItem[]; warnings: string[]; sourceCount: number }> {
  const sources = await gatherSources(query);
  const settled = await Promise.allSettled(sources.map(([, p]) => p));
  const items: ArtItem[] = [];
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    const name = sources[i][0];
    if (r.status === 'fulfilled') items.push(...r.value);
    else warnings.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  const ranked = rankResults(items, query, { qualityOf: (it) => qualityScore(it, query) })
    .slice(0, opts.max ?? DEFAULT_MAX_ITEMS);
  // sourceCount lets a caller tell "all sources errored" (→ 502) from "no matches" (→ empty).
  return { items: ranked, warnings, sourceCount: sources.length };
}

/** Knowledge-graph artist page: the artist node + a grid of their works from the dump
 *  deep-index (kept to the known work-id set). null when the QID isn't in the index. */
export async function loadArtistPage(
  qid: string,
  dataset: string = process.env.HARPE_DUMP_DATASET || '',
): Promise<{ entity: ArtistEntity; works: ArtItem[] } | null> {
  const [entity, workIds] = await Promise.all([fetchArtistEntity(qid), fetchArtistWorkIds(qid)]);
  if (!entity) return null;
  let works: ArtItem[] = [];
  if (dataset && workIds.length > 0) {
    const idSet = new Set(workIds);
    try {
      const all = await fetchDumpSearch(dataset, entity.labelEn);
      works = all.filter((it) => idSet.has(it.id)).slice(0, WORKS_CAP);
    } catch { /* dump unavailable → entity still renders, just no work grid */ }
  }
  return { entity, works };
}

/** Knowledge-graph subject ("depicts") page: the subject node + works whose P180
 *  depicts includes this QID (exact-matched on the deserialized array). null = unknown. */
export async function loadSubjectPage(
  qid: string,
  dataset: string = process.env.HARPE_DUMP_DATASET || '',
): Promise<{ entity: SubjectEntity; works: ArtItem[] } | null> {
  const entity = await fetchSubjectEntity(qid);
  if (!entity) return null;
  let works: ArtItem[] = [];
  if (dataset) {
    try {
      const all = await fetchDumpSearch(dataset, qid);
      works = all.filter((it) => it.depicts?.includes(qid)).slice(0, WORKS_CAP);
    } catch { /* dump unavailable → entity still renders, just no work grid */ }
  }
  return { entity, works };
}
