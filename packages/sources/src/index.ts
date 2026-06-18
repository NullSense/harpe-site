/**
 * @harpe/sources — Node-only museum/gallery source adapters.
 *
 * Public API:
 *   SOURCES        — full registry (SourceAdapter[])
 *   activeSources  — filtered by env (keyless or key present, non-disabled)
 *   gatherSources  — returns [label, Promise<ArtItem[]>][] for a query
 *   mapPool        — bounded-concurrency map (re-exported for art.ts handler)
 *
 * Adapters are re-exported for direct use in tests / CLI wrapper.
 */
export { SOURCES, activeSources, gatherSources } from './registry.js';
export { mapPool } from './helpers.js';
export { runSource, sourceBreaker } from './resilience.js';

// Re-export individual adapters so callers (e.g. CLI wrapper) can use them directly.
export {
  fetchAic, fetchMet, fetchCleveland, fetchCommons, fetchWikiArt, fetchVam,
  fetchWellcome, fetchSmk, fetchNasjonalmuseet, fetchDigitalNZ, fetchWikidata,
  fetchLoc, fetchEuropeana, fetchHarvard, fetchSmithsonian, fetchParisMusees,
  fetchDumpSource, fetchDumpSearch, fetchNypl, dumpDatasetEnv, dumpDatasetFor, h2Agent,
  fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity,
} from './adapters.js';
