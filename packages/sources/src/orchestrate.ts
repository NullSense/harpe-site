/**
 * High-level search + knowledge-graph orchestration — the engine's "verbs" composed
 * from the source adapters + the @harpe/core ranking pipeline. ONE implementation
 * shared by every frontend: the Vercel handlers (art / artist / depicts) AND the MCP
 * server, so ranking/dedup/entity-page logic never forks.
 */
import {
  rankResults, qualityScore, dedupe,
  type ArtItem, type ArtistEntity, type SubjectEntity,
} from '@harpe/core';
import { gatherSources } from './registry.js';
import { fetchArtistEntity, fetchArtistWorkIds, fetchSubjectEntity, fetchDumpSearch } from './adapters.js';
import { OVERALL_TIMEOUT_MS, withDeadline } from './helpers.js';

export const DEFAULT_MAX_ITEMS = 40;
const WORKS_CAP = 100;

/** Federated + dump search: fan out to every active source, collect, then dedupe +
 *  RRF-rank via the shared pipeline. A failing source becomes a warning, not an error.
 *
 *  Bounded by an OVERALL deadline (OVERALL_TIMEOUT_MS): unlike the SSE handler — which
 *  has its own timer — this batch path also backs /api/art, the MCP server and the
 *  keep-warm cron, none of which had a cap, so a single hung upstream could ride to
 *  Vercel's 60s function limit. At the deadline we return whatever resolved and flag the
 *  stragglers (the underlying fetches already self-abort via their per-source/dump
 *  policies; the platform reaps anything still pending once the function returns). */
export async function searchArt(
  query: string,
  opts: { max?: number; deadlineMs?: number } = {},
): Promise<{ items: ArtItem[]; warnings: string[]; sourceCount: number }> {
  const sources = await gatherSources(query);
  const items: ArtItem[] = [];
  const warnings: string[] = [];
  const settled = new Set<string>();
  const per = sources.map(([name, p]) =>
    p.then(
      (v) => { items.push(...v); settled.add(name); },
      (e) => { warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); settled.add(name); },
    ),
  );

  const deadlineMs = opts.deadlineMs ?? OVERALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); });
  await Promise.race([Promise.allSettled(per), deadline]);
  if (timer) clearTimeout(timer);

  // Any source not settled by the deadline → a per-source warning, so a TOTAL timeout
  // still reads as a total failure (warnings.length === sourceCount) for art.ts's 502.
  for (const [name] of sources) {
    if (!settled.has(name)) warnings.push(`${name}: timed out at ${deadlineMs}ms deadline`);
  }

  const ranked = rankResults(items, query, { qualityOf: (it) => qualityScore(it, query) })
    .slice(0, opts.max ?? DEFAULT_MAX_ITEMS);
  // sourceCount lets a caller tell "all sources errored" (→ 502) from "no matches" (→ empty).
  return { items: ranked, warnings, sourceCount: sources.length };
}

/** Knowledge-graph artist page: the artist node + a grid of their works from the dump
 *  deep-index (kept to the known work-id set). null when the QID isn't in the index.
 *
 *  Bounded like searchArt: the entity lookup and the dump-search both ride the HF policy
 *  (≤ ~26s each) and previously had NO outer cap, so /api/artist could reach Vercel's 60s
 *  limit on a cold index. The works fetch now degrades to [] at the deadline (the entity
 *  still renders), and a hung entity lookup yields null (rendered as 404, NOT cached — see
 *  withEntityCache — so a transient timeout self-heals on the next request). */
export async function loadArtistPage(
  qid: string,
  _dataset: string = process.env.HARPE_DUMP_DATASET || '', // vestigial: full search reads the dataset via env (gatherSources)
  opts: { deadlineMs?: number } = {},
): Promise<{ entity: ArtistEntity; works: ArtItem[]; attributedCount: number } | null> {
  const deadlineMs = opts.deadlineMs ?? OVERALL_TIMEOUT_MS;
  const [entity, workIds] = await withDeadline(
    deadlineMs,
    Promise.all([fetchArtistEntity(qid), fetchArtistWorkIds(qid)]),
    [null, []] as [ArtistEntity | null, string[]],
  );
  if (!entity) return null;
  // Full QID search: federate across ALL sources — dump AND live (Commons, WikiArt, …)
  // — so the artist's works surface wherever they live (e.g. Polish painters live on
  // Commons, not the US museum dumps), deduped via the shared pipeline so an institutional
  // scan wins the representative (museum badge, not Wikidata). Then split into the works
  // exactly attributed to THIS artist vs broader name matches — the UI's two sections.
  const idSet = new Set(workIds);
  const { items: ranked } = await searchArt(entity.labelEn, { max: WORKS_CAP, deadlineMs });
  const isAttributed = (it: ArtItem) =>
    it.artistId === qid || idSet.has(it.id) || (it.mergedIds ?? []).some((id) => idSet.has(id));
  const attributed = ranked.filter(isAttributed);
  const more = ranked.filter((it) => !isAttributed(it));
  return { entity, works: [...attributed, ...more], attributedCount: attributed.length };
}

/** Knowledge-graph subject ("depicts") page: the subject node + works whose P180
 *  depicts includes this QID (exact-matched on the deserialized array). null = unknown.
 *  Bounded identically to loadArtistPage (see its note). */
export async function loadSubjectPage(
  qid: string,
  dataset: string = process.env.HARPE_DUMP_DATASET || '',
  opts: { deadlineMs?: number } = {},
): Promise<{ entity: SubjectEntity; works: ArtItem[] } | null> {
  const deadlineMs = opts.deadlineMs ?? OVERALL_TIMEOUT_MS;
  const entity = await withDeadline(deadlineMs, fetchSubjectEntity(qid), null);
  if (!entity) return null;
  let works: ArtItem[] = [];
  if (dataset) {
    const all = await withDeadline(deadlineMs, fetchDumpSearch(dataset, qid).catch(() => []), []);
    // Attribution is by depicts QID (semantic), so DON'T relevance-filter by label —
    // just dedupe, which folds duplicate copies and lets the institutional scan win the
    // representative (museum badge, not Wikidata), keeping every depicting work.
    const depicting = all.filter((it) => it.depicts?.includes(qid));
    works = dedupe(depicting).slice(0, WORKS_CAP);
  }
  return { entity, works };
}
