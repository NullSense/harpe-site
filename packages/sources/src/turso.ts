/**
 * Turso (libSQL) search — the always-on FTS backend that replaces the cold HF
 * /filter path. Queries the imported art.sqlite schema (art + art_fts FTS5) over
 * the fetch-only @tursodatabase/serverless driver from the Vercel handlers, so the
 * auth token never reaches the browser. Activates only when TURSO_DATABASE_URL is
 * set; fetchDumpSearchUncached swaps its per-source row-fetcher to Turso then.
 *
 * SQL building is PURE and parameterized (injection-safe) so it's fully unit-tested
 * without the driver or a live DB. The driver boundary (getTursoClient) is thin and
 * verified live; row-fetchers accept an injected client so they're testable too.
 */

// The art content-table columns rowToItem consumes (the FTS index is a slim schema;
// fields absent here — canonical_id, nb_sitelinks, culture, … — map to empty, fine).
const COLS =
  'a.id, a.source, a.title, a.artist, a.date, a.medium, a.image_thumb, a.image_full, ' +
  'a.width, a.height, a.source_url, a.is_public_domain, a.wikidata_qid, a.artist_qid, ' +
  'a.depicts_qids, a.depicts_labels, a.movement';

export interface TursoFacets { artistQid?: string; depictsQid?: string; movement?: string }

/** Build an FTS5 MATCH expression: alnum tokens → quoted prefix terms, implicit AND.
 *  Strips FTS5-special chars so a stray `"`/`*` can't break or widen the match. */
export function ftsMatch(q: string): string {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ''))
    .filter((t) => t.length >= 2)
    .slice(0, 6)
    .map((t) => `"${t}"*`)
    .join(' ');
}

/**
 * Parameterized SELECT for one search, scoped to a `source` (the per-source fan-out
 * that prevents text-rich Wikidata rows from monopolising a single global query —
 * same invariant as the HF /filter path) and optionally narrowed by QID facets.
 * args line up with the `?` placeholders left-to-right. null = degenerate query.
 */
export function buildTursoSearch(
  q: string,
  opts: { source?: string; limit?: number; facets?: TursoFacets } = {},
): { sql: string; args: Array<string | number> } | null {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const f = opts.facets ?? {};
  // (clause, arg) pairs in SQL order so args can never drift from placeholders.
  const conds: Array<[string, string]> = [];
  if (opts.source) conds.push(['a.source = ?', opts.source]);
  let hasFacet = false;
  if (f.artistQid && /^Q\d+$/i.test(f.artistQid)) { conds.push(['a.artist_qid = ?', f.artistQid.toUpperCase()]); hasFacet = true; }
  if (f.depictsQid && /^Q\d+$/i.test(f.depictsQid)) { conds.push(['a.depicts_qids LIKE ?', `%${f.depictsQid.toUpperCase()}%`]); hasFacet = true; }
  if (f.movement) { const m = f.movement.trim(); if (m) { conds.push(['a.movement LIKE ?', `%${m}%`]); hasFacet = true; } }
  const condSql = conds.map(([c]) => c).join(' AND ');
  const condArgs = conds.map(([, a]) => a);

  const match = ftsMatch(q);
  if (match) {
    const tail = condSql ? ` AND ${condSql}` : '';
    return {
      sql: `SELECT ${COLS} FROM art_fts f JOIN art a ON a.rowid = f.rowid WHERE art_fts MATCH ?${tail} ORDER BY rank LIMIT ?`,
      args: [match, ...condArgs, limit],
    };
  }
  // No usable text: only allow a facet-driven scan (every work of a movement/subject).
  // A bare source with no text/facet is rejected — never a per-source match-all scan.
  if (hasFacet) return { sql: `SELECT ${COLS} FROM art a WHERE ${condSql} LIMIT ?`, args: [...condArgs, limit] };
  return null;
}

/**
 * Fuzzy fallback (typo/diacritic tolerance) — fired only when FTS returns too few
 * rows, so the common case never pays for the scan. Uses SQLean's always-on
 * fuzzy_jarowin (Jaro-Winkler 0–1) on artist/title. Thresholds are intentionally
 * conservative and want live tuning. null when the query is too short to be useful.
 */
export function buildTursoFuzzy(q: string, limit = 50): { sql: string; args: Array<string | number> } | null {
  const term = q.trim().toLowerCase();
  if (term.length < 3) return null; // too short → fuzzy is noise
  const lim = Math.min(Math.max(limit, 1), 200);
  return {
    sql:
      `SELECT ${COLS} FROM art a ` +
      `WHERE fuzzy_jarowin(lower(a.artist), ?) >= 0.86 OR fuzzy_jarowin(lower(a.title), ?) >= 0.9 LIMIT ?`,
    args: [term, term, lim],
  };
}

// ─── Driver boundary (thin; verified live) ───────────────────────────────────
type TursoClient = {
  execute: (q: { sql: string; args: Array<string | number> }) => Promise<{ rows?: Array<Record<string, unknown>> }>;
};
let _client: TursoClient | null | undefined;
// Non-literal specifier: tsc doesn't resolve it (the dep installs at deploy), and
// /* @vite-ignore */ keeps the client bundler from trying to analyze it.
const TURSO_PKG = '@tursodatabase/serverless';

export async function getTursoClient(): Promise<TursoClient | null> {
  if (_client !== undefined) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) return (_client = null);
  const mod = (await import(/* @vite-ignore */ TURSO_PKG)) as {
    createClient: (o: { url: string; authToken?: string }) => TursoClient;
  };
  return (_client = mod.createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }));
}

/** Per-source FTS rows for the fan-out. [] when Turso is off or the query is degenerate,
 *  but a client error PROPAGATES so the fan-out tracks it as a per-source failure (so a
 *  total Turso outage reads as "all dump sources failed", never a cached empty result). */
export async function tursoFilterRows(
  source: string,
  q: string,
  opts: { facets?: TursoFacets; limit?: number; client?: TursoClient } = {},
): Promise<Array<Record<string, unknown>>> {
  const c = opts.client ?? (await getTursoClient());
  if (!c) return [];
  const built = buildTursoSearch(q, { source, facets: opts.facets, limit: opts.limit });
  if (!built) return [];
  const res = await c.execute(built);
  return res.rows ?? [];
}

/** Global fuzzy-fallback rows (typo/diacritic tolerance). Returns [] when off/empty. */
export async function tursoFuzzyRows(
  q: string,
  opts: { limit?: number; client?: TursoClient } = {},
): Promise<Array<Record<string, unknown>>> {
  const c = opts.client ?? (await getTursoClient());
  if (!c) return [];
  const built = buildTursoFuzzy(q, opts.limit);
  if (!built) return [];
  try {
    const res = await c.execute(built);
    return res.rows ?? [];
  } catch {
    return [];
  }
}

/** Test-only: reset the memoised client between cases. */
export function _resetTursoClient(): void {
  _client = undefined;
}
