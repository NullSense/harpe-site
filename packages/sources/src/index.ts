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
export { searchArt, loadArtistPage, loadSubjectPage, DEFAULT_MAX_ITEMS } from './orchestrate.js';
export { mapPool } from './helpers.js';
// Unified search timing budget (single source of truth; invariant in budget.test.ts).
export {
  TIMEOUT_MS, DUMP_TIMEOUT_MS, DUMP_RETRIES, DUMP_BACKOFF_MAX_MS, DUMP_WORST_CASE_MS,
  ENRICH_BUDGET_MS, OVERALL_TIMEOUT_MS,
} from './helpers.js';
export { runSource, sourceBreaker } from './resilience.js';

// Re-export individual adapters so callers (e.g. CLI wrapper) can use them directly.
export {
  fetchAic, fetchMet, fetchCleveland, fetchCommons, fetchWikiArt, fetchVam,
  fetchWellcome, fetchSmk, fetchNasjonalmuseet, fetchDigitalNZ, fetchWikidata,
  fetchLoc, fetchEuropeana, fetchHarvard, fetchSmithsonian, fetchParisMusees,
  fetchDumpSource, fetchDumpSearch, fetchDumpPage, fetchNypl, dumpDatasetEnv, dumpDatasetFor, h2Agent,
  fetchItemById, fetchDumpItemById, fetchCommonsItemById,
  fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity, resolveQueryEntity,
  fetchSuggestions,
} from './adapters.js';
