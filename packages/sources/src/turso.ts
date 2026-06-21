/**
 * Turso (libSQL) search — the always-on FTS backend that replaces the cold HF
 * /filter path. Queries the imported art.sqlite schema (art + art_fts FTS5) over
 * the fetch-only @tursodatabase/serverless driver from the Vercel handlers, so the
 * auth token never reaches the browser. Activates only when TURSO_DATABASE_URL is
 * set (A/B against HF /filter, then flip).
 *
 * This module keeps the SQL-building PURE and parameterized (no quote-escaping,
 * injection-safe) so it's fully testable without the driver or a live DB.
 */

// The art content-table columns rowToItem consumes (the FTS index is a slim schema;
// fields absent here — canonical_id, nb_sitelinks, culture, … — map to empty, fine).
const COLS =
  'a.id, a.source, a.title, a.artist, a.date, a.medium, a.image_thumb, a.image_full, ' +
  'a.width, a.height, a.source_url, a.is_public_domain, a.wikidata_qid, a.artist_qid, ' +
  'a.depicts_qids, a.depicts_labels, a.movement';

export interface TursoFacets { artistQid?: string; depictsQid?: string; movement?: string }

/** Build an FTS5 MATCH expression from a user query: alnum tokens → quoted prefix
 *  terms joined by implicit AND. Strips FTS5-special characters so a stray `"` or
 *  `*` can't break the match or change its meaning. Empty when no usable token. */
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
 * Build the parameterized SELECT for a search (optionally narrowed by QID facets).
 * Returns null for a degenerate query (no text AND no valid facet) so we never run a
 * match-all scan. args line up with the `?` placeholders left-to-right.
 */
export function buildTursoSearch(
  q: string,
  opts: { limit?: number; facets?: TursoFacets } = {},
): { sql: string; args: Array<string | number> } | null {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const f = opts.facets ?? {};
  const where: string[] = [];
  const facetArgs: string[] = [];
  if (f.artistQid && /^Q\d+$/i.test(f.artistQid)) { where.push('a.artist_qid = ?'); facetArgs.push(f.artistQid.toUpperCase()); }
  if (f.depictsQid && /^Q\d+$/i.test(f.depictsQid)) { where.push('a.depicts_qids LIKE ?'); facetArgs.push(`%${f.depictsQid.toUpperCase()}%`); }
  if (f.movement) { const m = f.movement.trim(); if (m) { where.push('a.movement LIKE ?'); facetArgs.push(`%${m}%`); } }

  const match = ftsMatch(q);
  if (match) {
    const facet = where.length ? ' AND ' + where.join(' AND ') : '';
    const sql =
      `SELECT ${COLS} FROM art_fts f JOIN art a ON a.rowid = f.rowid ` +
      `WHERE art_fts MATCH ?${facet} ORDER BY rank LIMIT ?`;
    return { sql, args: [match, ...facetArgs, limit] };
  }
  // Facet-only query (no usable text) — e.g. every work of a movement / depicting a subject.
  if (where.length) {
    return { sql: `SELECT ${COLS} FROM art a WHERE ${where.join(' AND ')} LIMIT ?`, args: [...facetArgs, limit] };
  }
  return null;
}
